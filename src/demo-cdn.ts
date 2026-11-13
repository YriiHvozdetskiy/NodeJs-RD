import { fork, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import { IMMUTABLE_CACHE_CONTROL, publishAsset } from './files/assets';
import { purgePrefix } from './files/demo-kit';
import { ObjectStorage } from './files/object-storage';
import { Summary } from './messaging/demo-kit';

/**
 * demo:cdn — пункти 4–5 ДЗ #26: сховище закрите, роздача через кеш,
 * оновлення без інвалідації.
 *
 *   GET  сховище/assets/…app.<h1>.css  анонімно       → 403  бакет приватний
 *   GET  edge/assets/…app.<h1>.css     перший        → 200  X-Cache: MISS — edge сходив у сховище своїми ключами
 *   GET  edge/assets/…app.<h1>.css     другий        → 200  X-Cache: HIT
 *   «деплой»: новий вміст → app.<h2>.css             → нове імʼя
 *   GET  edge/assets/…app.<h2>.css                   → 200  новий вміст, інвалідацій — нуль
 *
 * Контраст понад контракт: мутабельне імʼя app.css з тим самим заголовком.
 * Після перезапису edge упевнено віддає СТАРЕ — його довелось би інвалідувати.
 * Клієнт із `Cache-Control: no-cache` змушує edge перепитати origin: змінений
 * app.css приходить новим (MISS), незмінний ассет — з кешу після звірки ETag
 * (REVALIDATED).
 */
const PREFIX = 'assets/demo-cdn/';

const V1 = Buffer.from('.price{color:#c00}\n');
const V2 = Buffer.from('.price{color:#0a0;font-weight:700}\n');

interface EdgeReply {
  status: number;
  cache: string;
  cacheControl: string;
  body: string;
}

async function get(url: string, headers: Record<string, string> = {}): Promise<EdgeReply> {
  const res = await fetch(url, { headers });
  return {
    status: res.status,
    cache: res.headers.get('x-cache') ?? '',
    cacheControl: res.headers.get('cache-control') ?? '',
    body: await res.text(),
  };
}

function isReady(m: unknown): m is { t: 'ready'; url: string } {
  return typeof m === 'object' && m !== null && 't' in m && m.t === 'ready' && 'url' in m && typeof m.url === 'string';
}

/** Edge окремим процесом: ключі сховища є в нього, а не в «публіки», яка ходить через fetch. */
function startEdge(): Promise<{ url: string; proc: ChildProcess }> {
  const proc = fork(path.join(__dirname, 'edge.js'), { env: { ...process.env, EDGE_PORT: '0' }, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error('edge не стартував за 15 с'));
    }, 15_000);
    proc.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`edge вийшов з кодом ${code} до готовності`));
    });
    proc.on('message', (m) => {
      if (!isReady(m)) return;
      clearTimeout(timer);
      proc.removeAllListeners('exit');
      resolve({ url: m.url, proc });
    });
  });
}

async function stopEdge(proc: ChildProcess | undefined): Promise<void> {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()));
  proc.kill('SIGTERM');
  const forced = setTimeout(() => proc.kill('SIGKILL'), 5_000);
  await exited;
  clearTimeout(forced);
}

async function main(): Promise<void> {
  const summary = new Summary();
  const storage = ObjectStorage.fromEnv();
  let edge: { url: string; proc: ChildProcess } | undefined;

  try {
    await storage.ensureBucket();
    // Чистий стан: кеш edge порожній, бо це новий процес; ассети демо — прибрано.
    await purgePrefix(storage, PREFIX);

    // ── 1. публікація v1: хеш в імені, Cache-Control на обʼєкті ──────────
    const key1 = await publishAsset(storage, { dir: 'demo-cdn', name: 'app', ext: 'css', contentType: 'text/css', body: V1 });
    console.log(`── demo:cdn: опубліковано ${key1} з "${IMMUTABLE_CACHE_CONTROL}" ──`);

    // ── 2. повз кеш: анонімний GET прямо у сховище ───────────────────────
    const direct = await fetch(storage.directUrl(key1));
    await direct.body?.cancel();
    summary.line('direct', direct.status);

    // ── 3. через кеш: промах, потім попадання ────────────────────────────
    edge = await startEdge();
    console.log(`   edge на ${edge.url}`);
    const miss = await get(`${edge.url}/${key1}`);
    summary.line('edge-miss', miss.status);
    const hit = await get(`${edge.url}/${key1}`);
    summary.line('edge-hit', hit.status);
    const cacheHit = miss.cache === 'MISS' && hit.cache === 'HIT' ? 1 : 0;
    summary.line('cache-hit', cacheHit);
    console.log(`   X-Cache: ${miss.cache} → ${hit.cache} · Cache-Control: ${hit.cacheControl}`);

    // ── 4. «деплой»: новий вміст — нове імʼя — новий URL ─────────────────
    const key2 = await publishAsset(storage, { dir: 'demo-cdn', name: 'app', ext: 'css', contentType: 'text/css', body: V2 });
    console.log(`   деплой: ${key1} → ${key2}`);
    const newName = key2 !== key1 ? 1 : 0;
    summary.line('new-name', newName);
    const fresh = await get(`${edge.url}/${key2}`);
    summary.line('new-url', fresh.status);
    const contentChanged = fresh.body === V2.toString() && fresh.body !== miss.body ? 1 : 0;
    summary.line('content-changed', contentChanged);
    // Старий запис нікому не заважає: стара сторінка, яка ще посилається на v1, отримує v1.
    const old = await get(`${edge.url}/${key1}`);
    summary.line('old-url-still-v1', old.cache === 'HIT' && old.body === V1.toString() ? 1 : 0);
    summary.line('invalidations', 0);

    // ── 5. контраст: мутабельне імʼя з тим самим річним кешем ────────────
    const mutable = `${PREFIX}app.css`;
    await storage.put(mutable, V1, { contentType: 'text/css', cacheControl: IMMUTABLE_CACHE_CONTROL });
    await get(`${edge.url}/${mutable}`);
    await storage.put(mutable, V2, { contentType: 'text/css', cacheControl: IMMUTABLE_CACHE_CONTROL });
    const stale = await get(`${edge.url}/${mutable}`);
    const mutableStale = stale.cache === 'HIT' && stale.body === V1.toString() ? 1 : 0;
    summary.line('mutable-name-stale', mutableStale);
    console.log('   app.css перезаписано у сховищі, а edge віддає стару версію: без хешу в імені тут потрібна інвалідація');

    // ── 6. клієнт просить перевірки: Cache-Control: no-cache ─────────────
    // Змінений обʼєкт: ETag в origin інший — edge бере нове тіло і кешує його.
    const forced = await get(`${edge.url}/${mutable}`, { 'cache-control': 'no-cache' });
    const noCacheFresh = forced.cache === 'MISS' && forced.body === V2.toString() ? 1 : 0;
    summary.line('no-cache-fresh', noCacheFresh);
    const after = await get(`${edge.url}/${mutable}`);
    const noCacheRecached = after.cache === 'HIT' && after.body === V2.toString() ? 1 : 0;
    summary.line('no-cache-recached', noCacheRecached);
    // Незмінний обʼєкт: ETag той самий — тіло з кешу, origin віддав лише метадані.
    const checked = await get(`${edge.url}/${key2}`, { 'cache-control': 'no-cache' });
    const noCacheRevalidated = checked.cache === 'REVALIDATED' && checked.body === V2.toString() ? 1 : 0;
    summary.line('no-cache-revalidated', noCacheRevalidated);
    console.log(`   no-cache: змінений app.css → ${forced.cache}, далі ${after.cache}; незмінний ассет → ${checked.cache}`);

    summary.expect('direct=403 — бакет не читається повз кеш', direct.status === 403);
    summary.expect('edge-miss=200 — edge читає приватний бакет своїми ключами', miss.status === 200);
    summary.expect('edge-hit=200', hit.status === 200);
    summary.expect('cache-hit=1 — другий запит із кешу', cacheHit === 1);
    summary.expect('Cache-Control з origin доїхав до клієнта', hit.cacheControl === IMMUTABLE_CACHE_CONTROL);
    summary.expect('new-name=1 — новий вміст під новим імʼям', newName === 1);
    summary.expect('new-url=200', fresh.status === 200);
    summary.expect('content-changed=1', contentChanged === 1);
    summary.expect('мутабельне імʼя справді застаріває в кеші (контрольний прогін)', mutableStale === 1);
    summary.expect('no-cache-fresh=1 — на no-cache edge іде в origin і бере нову версію', noCacheFresh === 1);
    summary.expect('no-cache-recached=1 — нова версія лягла в кеш', noCacheRecached === 1);
    summary.expect('no-cache-revalidated=1 — незмінний обʼєкт звірено за ETag, тіло з кешу', noCacheRevalidated === 1);
  } finally {
    await stopEdge(edge?.proc);
    await purgePrefix(storage, PREFIX).catch(() => undefined);
    storage.destroy();
  }
  summary.finish();
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
