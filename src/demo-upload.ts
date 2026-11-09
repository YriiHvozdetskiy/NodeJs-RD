import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { DataSource } from 'typeorm';
import { dataSourceOptions } from './data-source';
import { call, cleanup, createUser, detailOf, login, tokensOf, type Reply } from './auth/demo-kit';
import { field, portAlive, purgeDemoFiles, runWorker, tempFile } from './files/demo-kit';
import { ObjectStorage } from './files/object-storage';
import { Summary } from './messaging/demo-kit';
import { migrateSchema, startApi, type Api } from './redis/demo-kit';

/**
 * demo:upload — пункти 1–2 ДЗ #26: байти йдуть повз наш сервіс.
 *
 *   POST /uploads/intent  filename=../../etc/passwd   → 200, ключ склав сервер
 *   PUT  <URL з підміненим ключем>                    → 403  підпис накриває шлях
 *   POST /uploads/{інший}/commit  без жодного PUT     → 409  commit робить HeadObject
 *   застосунок зупинено                                → порт мертвий
 *   PUT  <URL> з процесу без жодного ключа            → 200  байти у сховищі без нас
 *   застосунок на ІНШОМУ порту, commit                 → 200
 *   PUT  <URL зі строком 3 с> одразу і через 4,5 с     → 200, потім 403
 *
 * Головна пара — api-alive=0 і put-offline=200. Рішення, що проксіює файл
 * через бекенд, дає put-offline=0: бекенда в цей момент немає.
 */
const DEMO = 'upload';

/** Сигнатура PNG і тіло: commit звіряє перші байти з заявленим типом. */
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(1_000)]);

/**
 * Строк для перевірки протухання. Не той, що видає intent (61 с для цього
 * файла): чекати хвилину в кожному прогоні нема сенсу. Підписує та сама
 * функція presignPut, що й intent, — відрізняється лише число.
 */
const SHORT_TTL_SEC = 3;

const s3CodeOf = (xml: string): string => /<Code>([^<]+)<\/Code>/.exec(xml)?.[1] ?? '';

async function main(): Promise<void> {
  const summary = new Summary();
  const storage = ObjectStorage.fromEnv();
  const dataSource = await new DataSource(dataSourceOptions).initialize();
  const png = await tempFile('avatar.png', PNG);
  let api: Api | undefined;

  try {
    await migrateSchema();
    await storage.ensureBucket();
    await purgeDemoFiles(dataSource, storage, DEMO);
    await cleanup(dataSource, DEMO);
    const user = await createUser(dataSource, DEMO, 'uploader', 'buyer');
    api = await startApi();
    const token = tokensOf(await login(api, user)).access;
    console.log(`── demo:upload: користувач ${user.email} (id ${user.id}), застосунок на ${api.url} ──`);

    const step = (key: string, reply: Reply): number => {
      summary.line(key, reply.status);
      const detail = detailOf(reply);
      if (detail) console.log(`   ${key}: ${detail}`);
      return reply.status;
    };

    // ── 1. intent з навмисно шкідливим filename ──────────────────────────
    const body = { filename: '../../etc/passwd', content_type: 'image/png', size: PNG.length };
    const intent = await call(api, 'POST', '/uploads/intent', { token, body });
    const statusIntent = step('intent', intent);
    const fileId = String(field(intent.json, 'file_id') ?? '');
    const key = String(field(intent.json, 'key') ?? '');
    const url = String(field(intent.json, 'url') ?? '');
    const ttl = Number(field(intent.json, 'expires_in'));
    const keyFromServer = key === `uploads/${user.id}/${fileId}.png` && !key.includes('passwd') && !key.includes('..') ? 1 : 0;
    summary.line('key-from-server', keyFromServer);
    summary.line('url-ttl-seconds', ttl);
    // Ключ і file_id — у лог можна. Сам URL — ні: він і є доступ до кінця строку.
    console.log(`   ключ від сервера: ${key} (filename клієнта: ${body.filename})`);

    // Подвійний тап: той самий Idempotency-Key — той самий файл, а не другий.
    const idemKey = `demo-${randomUUID()}`;
    const tap = async (): Promise<string> => {
      const res = await fetch(`${api?.url}/v1/uploads/intent`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': idemKey },
        body: JSON.stringify(body),
      });
      return String(field(await res.json(), 'file_id') ?? 'немає');
    };
    const [firstTap, secondTap] = [await tap(), await tap()];
    summary.line('double-tap-same-file', firstTap === secondTap && firstTap !== 'немає' ? 1 : 0);

    // ── 2. підпис накриває шлях: інший ключ у тому самому URL ────────────
    const tamperedRes = await fetch(url.replace(`${fileId}.png`, `${randomUUID()}.png`), {
      method: 'PUT',
      body: PNG,
      headers: { 'content-type': 'image/png' },
    });
    summary.line('tampered', tamperedRes.status);
    console.log(`   tampered: ${s3CodeOf(await tamperedRes.text())}`);

    // ── 3. commit того, чого не заливали ─────────────────────────────────
    const empty = await call(api, 'POST', '/uploads/intent', { token, body: { filename: 'empty.png', content_type: 'image/png', size: PNG.length } });
    const emptyId = String(field(empty.json, 'file_id') ?? '');
    const statusWithoutBytes = step('commit-without-bytes', await call(api, 'POST', `/uploads/${emptyId}/commit`, { token }));

    // ── 4. наш застосунок вимкнено ───────────────────────────────────────
    const deadUrl = api.url;
    await api.close();
    api = undefined;
    const alive = await portAlive(deadUrl);
    summary.line('api-alive', alive);

    // ── 5. PUT з окремого процесу без жодного ключа в оточенні ───────────
    const offline = await runWorker({ mode: 'put', url, file: png.file, contentType: 'image/png' });
    let putOffline = 0;
    let clientSecretVars = -1;
    for (const r of offline.reports) {
      if (r.t === 'put') putOffline = r.status;
      if (r.t === 'env') clientSecretVars = r.secretVars;
      if (r.t === 'error') console.log(`   клієнт: ${r.message}`);
    }
    summary.line('put-offline', putOffline);
    summary.line('client-secret-vars', clientSecretVars);

    // ── 6. застосунок знову, на ІНШОМУ порту: fetch тримає пул на (host, port) ──
    api = await startApi();
    console.log(`   застосунок знову на ${api.url}`);
    const commit = await call(api, 'POST', `/uploads/${fileId}/commit`, { token });
    const statusCommit = step('commit', commit);
    const committed = field(commit.json, 'status') === 'completed' && field(commit.json, 'size') === PNG.length;
    summary.line('committed-size-match', committed ? 1 : 0);

    // Понад контракт: віддача — 302 на presigned GET на хвилину, через гард.
    const download = await fetch(`${api.url}/v1/files/${fileId}`, { headers: { authorization: `Bearer ${token}` }, redirect: 'manual' });
    summary.line('download', download.status);
    const location = download.headers.get('location');
    const downloaded = location ? Buffer.from(await (await fetch(location)).arrayBuffer()) : Buffer.alloc(0);
    summary.line('download-match', downloaded.equals(PNG) ? 1 : 0);

    // ── 7. той самий URL після протухання ────────────────────────────────
    const scratchKey = `uploads/${user.id}/${randomUUID()}.png`;
    const shortUrl = await storage.presignPut(scratchKey, 'image/png', SHORT_TTL_SEC);
    const signedAt = Date.now();
    const putShort = (): Promise<Response> => fetch(shortUrl, { method: 'PUT', body: PNG, headers: { 'content-type': 'image/png' } });
    const fresh = await putShort();
    await fresh.body?.cancel();
    summary.line('fresh-before-expiry', fresh.status);
    // Плюс 1,5 с понад строк: годинник контейнера сховища може відставати від хоста.
    await sleep(Math.max(0, SHORT_TTL_SEC * 1000 + 1_500 - (Date.now() - signedAt)));
    const expiredRes = await putShort();
    summary.line('expired', expiredRes.status);
    console.log(`   expired: ${s3CodeOf(await expiredRes.text())}`);

    summary.expect('intent=200', statusIntent === 200);
    summary.expect('key-from-server=1 — filename клієнта не дійшов до ключа', keyFromServer === 1);
    summary.expect('строк URL intent — хвилини, а не дні', ttl > 0 && ttl <= 3600);
    summary.expect('подвійний intent з тим самим Idempotency-Key — той самий файл', firstTap === secondTap);
    summary.expect('tampered=403 — підпис накриває ключ', tamperedRes.status === 403);
    summary.expect('commit-without-bytes=4xx — commit робить HeadObject', statusWithoutBytes >= 400 && statusWithoutBytes < 500);
    summary.expect('api-alive=0 — застосунок справді вимкнено', alive === 0);
    summary.expect('put-offline=200 — байти у сховищі без нашого API', putOffline === 200);
    summary.expect('у клієнта немає жодного ключа', clientSecretVars === 0);
    summary.expect('commit=200 і розмір збігається', statusCommit === 200 && committed);
    summary.expect('download=302 і віддає ті самі байти', download.status === 302 && downloaded.equals(PNG));
    summary.expect('URL працює до строку', fresh.status === 200);
    summary.expect('expired=403 — той самий URL після строку', expiredRes.status === 403);
  } finally {
    await api?.close();
    await purgeDemoFiles(dataSource, storage, DEMO).catch(() => undefined);
    await cleanup(dataSource, DEMO).catch(() => undefined);
    await dataSource.destroy();
    storage.destroy();
    await png.remove();
  }
  summary.finish();
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
