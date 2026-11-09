import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { ObjectStorage, type StoredObject } from './files/object-storage';

/**
 * Кеш-шар перед сховищем (#26) — локальна форма CloudFront + OAC.
 *
 * Суть OAC в одному реченні: до сховища ходить кеш, а не публіка. Бакет
 * приватний — анонімний GET у нього дає 403. Цей процес тримає ключі сховища
 * (зі сховища секретів #11, через with-secrets.sh) і бере обʼєкт клієнтом SDK
 * зі своїм підписом. Публіка бачить лише його.
 *
 * Що чесно однакове з CDN: shared cache у термінах RFC 9111 — свіжість бере
 * з `Cache-Control` обʼєкта, віддає `ETag`, відповідає 304 на умовний запит.
 * Що інше: одна точка присутності замість сотень, кеш у памʼяті процесу,
 * немає інвалідації через API. Остання не потрібна — див. src/files/assets.ts.
 *
 *   npm run edge                 # http://127.0.0.1:22660/assets/…
 *   EDGE_PORT=0 node dist/edge.js # вільний порт; адресу отримує процес-батько по IPC
 */

/** Роздається лише публічний префікс. `uploads/` — приватні файли користувачів, і кеш їх не бачить. */
const PUBLIC_PREFIX = 'assets/';
/** Ключ — лише безпечні символи: жодних `..`, `%`, порожніх сегментів. */
const SAFE_KEY = /^assets\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/;

/** Стеля памʼяті кешу. Ассети вітрини — десятки КіБ; великий обʼєкт віддається, але не кешується. */
const MAX_CACHE_BYTES = 64 * 1024 * 1024;
const MAX_ENTRY_BYTES = 8 * 1024 * 1024;

interface Entry {
  object: StoredObject;
  storedAt: number;
  expiresAt: number;
}

/**
 * Скільки секунд спільний кеш може тримати обʼєкт. Немає `Cache-Control` —
 * нуль: евристичного кешування (RFC 9111 §4.2.2) свідомо не робимо, бо
 * політику свіжості задає origin, а не кеш. `private`, `no-store` — нуль.
 */
export function sharedMaxAge(cacheControl: string | undefined): number {
  if (!cacheControl) return 0;
  const directives = new Map(
    cacheControl.split(',').map((part) => {
      const [name, value] = part.trim().toLowerCase().split('=');
      return [name, value] as const;
    }),
  );
  if (directives.has('no-store') || directives.has('private')) return 0;
  const seconds = Number(directives.get('s-maxage') ?? directives.get('max-age'));
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
}

/** LRU поверх Map: Map памʼятає порядок вставки, тож перший ключ — найдавніше прочитаний. */
class LruCache {
  private readonly entries = new Map<string, Entry>();
  private bytes = 0;

  get(key: string): Entry | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry;
  }

  set(key: string, entry: Entry): void {
    this.drop(key);
    this.entries.set(key, entry);
    this.bytes += entry.object.size;
    for (const [oldest, old] of this.entries) {
      if (this.bytes <= MAX_CACHE_BYTES) break;
      this.entries.delete(oldest);
      this.bytes -= old.object.size;
    }
  }

  private drop(key: string): void {
    const old = this.entries.get(key);
    if (!old) return;
    this.entries.delete(key);
    this.bytes -= old.object.size;
  }
}

function send(req: IncomingMessage, res: ServerResponse, object: StoredObject, cache: 'HIT' | 'MISS', ageSec: number): void {
  res.setHeader('X-Cache', cache);
  res.setHeader('Age', String(ageSec));
  res.setHeader('ETag', object.etag);
  // Заголовок origin іде далі як є: браузер теж кешуватиме рік і не перепитає.
  if (object.cacheControl) res.setHeader('Cache-Control', object.cacheControl);
  if (req.headers['if-none-match'] === object.etag) {
    res.statusCode = 304;
    res.end();
    return;
  }
  res.setHeader('Content-Type', object.contentType ?? 'application/octet-stream');
  res.setHeader('Content-Length', String(object.size));
  res.statusCode = 200;
  res.end(req.method === 'HEAD' ? undefined : object.body);
}

function fail(res: ServerResponse, status: number, text: string): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end(`${text}\n`);
}

export function createEdge(storage: ObjectStorage): ReturnType<typeof createServer> {
  const cache = new LruCache();

  return createServer((req, res) => {
    void (async () => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.setHeader('Allow', 'GET, HEAD');
        return fail(res, 405, 'лише GET і HEAD');
      }
      const path = new URL(req.url ?? '/', 'http://edge').pathname;
      if (path === '/healthz') return fail(res, 200, 'ok');
      const key = path.slice(1);
      if (!key.startsWith(PUBLIC_PREFIX) || !SAFE_KEY.test(key)) return fail(res, 404, 'не знайдено');

      const now = Date.now();
      const cached = cache.get(key);
      if (cached && now < cached.expiresAt) {
        return send(req, res, cached.object, 'HIT', Math.floor((now - cached.storedAt) / 1000));
      }

      // Промах: кеш іде в origin СВОЇМИ ключами. Це і є OAC.
      const object = await storage.get(key);
      if (!object) return fail(res, 404, 'не знайдено');
      const ttl = sharedMaxAge(object.cacheControl);
      if (ttl > 0 && object.size <= MAX_ENTRY_BYTES) {
        cache.set(key, { object, storedAt: now, expiresAt: now + ttl * 1000 });
      }
      send(req, res, object, 'MISS', 0);
    })().catch((err: unknown) => {
      console.error(`edge: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) fail(res, 502, 'origin недоступний');
      else res.destroy();
    });
  });
}

function main(): void {
  const storage = ObjectStorage.fromEnv();
  const server = createEdge(storage);
  const port = Number(process.env.EDGE_PORT ?? 22660);
  server.listen(port, process.env.EDGE_HOST ?? '127.0.0.1', () => {
    const address = server.address();
    const url = typeof address === 'object' && address !== null ? `http://${address.address}:${address.port}` : String(address);
    // Під demo:cdn процес-батько чекає адресу по IPC; з терміналу — у консоль.
    if (process.send) process.send({ t: 'ready', url });
    else console.log(`edge → ${url}/assets/… (bucket ${storage.bucket})`);
  });
  const stop = (): void => {
    server.close();
    server.closeAllConnections();
    storage.destroy();
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

if (require.main === module) main();
