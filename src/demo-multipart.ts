import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { DataSource } from 'typeorm';
import { dataSourceOptions } from './data-source';
import { call, cleanup, createUser, detailOf, login, tokensOf } from './auth/demo-kit';
import { field, headStatus, purgeDemoFiles, runWorker, tempFile } from './files/demo-kit';
import { ObjectStorage } from './files/object-storage';
import { MULTIPART_THRESHOLD, partSizeFor } from './files/upload-policy';
import { Summary } from './messaging/demo-kit';
import { migrateSchema, startApi, type Api } from './redis/demo-kit';

/**
 * demo:multipart — пункт 3 ДЗ #26: multipart — це відновлення, а не «великі файли».
 *
 *   POST /uploads/intent  11 МіБ video/mp4    → CreateMultipartUpload, URL на 3 частини
 *   процес №1 заливає частини 1 і 2 → SIGKILL  (без finally, без Abort)
 *   HeadObject                                 → 404: частини лежать, обʼєкта немає
 *   процес №2: GET /uploads/{id}/parts         → ListParts у сховищі: є 1,2 — доливає лише 3
 *   HeadObject                                 → 404: усі три частини є, обʼєкта ще немає
 *   POST /uploads/{id}/commit                  → CompleteMultipartUpload → 200
 *   HeadObject                                 → розмір збігається, ETag "…-3" і це не MD5
 *
 * Серце — resumed-parts=1. Рішення без ListParts заливає всі три.
 */
const DEMO = 'multipart';
const MiB = 1024 * 1024;

/** 5 + 5 + 1 МіБ: дві повні частини і хвіст. Остання частина може бути < 5 МіБ, решта — ні. */
const SIZE = 11 * MiB;

/**
 * Детерміноване тіло: частина n заповнена цифрою n, на початку — заголовок
 * MP4 (`ftyp` з 4-го байта). Той самий вміст щоразу — той самий ETag щоразу.
 */
function videoBody(): Buffer {
  const partSize = partSizeFor(SIZE);
  const body = Buffer.alloc(SIZE);
  for (let offset = 0, n = 1; offset < SIZE; offset += partSize, n += 1) body.fill(String(n), offset, Math.min(SIZE, offset + partSize));
  Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]).copy(body, 0);
  return body;
}

async function main(): Promise<void> {
  const summary = new Summary();
  const storage = ObjectStorage.fromEnv();
  const dataSource = await new DataSource(dataSourceOptions).initialize();
  const body = videoBody();
  const video = await tempFile('product.mp4', body);
  let api: Api | undefined;

  try {
    await migrateSchema();
    await storage.ensureBucket();
    // Хвости попереднього прогону: незавершені завантаження (ListMultipartUploads →
    // AbortMultipartUpload), обʼєкти, рядки files, користувачі.
    await purgeDemoFiles(dataSource, storage, DEMO);
    await cleanup(dataSource, DEMO);
    const user = await createUser(dataSource, DEMO, 'seller', 'seller');
    api = await startApi();
    const token = tokensOf(await login(api, user)).access;
    console.log(`── demo:multipart: ${SIZE} Б, поріг multipart ${MULTIPART_THRESHOLD} Б, застосунок на ${api.url} ──`);

    // ── 1. intent: файл понад поріг → multipart ──────────────────────────
    const intent = await call(api, 'POST', '/uploads/intent', {
      token,
      body: { filename: 'product.mp4', content_type: 'video/mp4', size: SIZE },
    });
    summary.line('intent', intent.status);
    if (intent.status !== 200) throw new Error(`intent → ${intent.status}: ${detailOf(intent)}`);
    const fileId = String(field(intent.json, 'file_id') ?? '');
    const key = String(field(intent.json, 'key') ?? '');
    const partSize = Number(field(intent.json, 'part_size'));
    const partCount = Number(field(intent.json, 'part_count'));
    const partsJson = field(intent.json, 'parts');
    const parts = Array.isArray(partsJson)
      ? partsJson.map((p: unknown) => ({ part_number: Number(field(p, 'part_number')), url: String(field(p, 'url') ?? '') }))
      : [];
    summary.line('part-size', partSize);
    summary.line('part-count', partCount);

    // ── 2. процес №1 заливає дві частини і гине від SIGKILL ──────────────
    const first = await runWorker({ mode: 'parts', file: video.file, partSize, parts, dieAfter: 2 });
    const sentBeforeCrash = first.reports.filter((r) => r.t === 'part' && r.status === 200).length;
    summary.line('sent-before-crash', sentBeforeCrash);
    summary.line('crashed-sigkill', first.signal === 'SIGKILL' ? 1 : 0);
    const partsAfterCrash = (await storage.listParts(key, await uploadIdOf(dataSource, fileId))).length;
    summary.line('parts-on-server', partsAfterCrash);
    const headAfterCrash = await headStatus(storage, key);
    summary.line('head-after-crash', headAfterCrash);

    // ── 3. процес №2: нічого не знає про №1, крім file_id ────────────────
    const second = await runWorker({ mode: 'resume', api: api.url, token, fileId, file: video.file });
    let resumed = -1;
    let alreadyThere: number[] = [];
    for (const r of second.reports) {
      if (r.t === 'resume') {
        resumed = r.sent.length;
        alreadyThere = r.uploaded;
      }
      if (r.t === 'error') console.log(`   процес №2: ${r.message}`);
    }
    console.log(`   процес №2: у сховищі вже були частини ${alreadyThere.join(',') || '—'}, долито ${resumed}`);
    summary.line('resumed-parts', resumed);

    // ── 4. до Complete обʼєкта немає, хоча лежать усі частини ────────────
    const headBefore = await headStatus(storage, key);
    summary.line('head-before-complete', headBefore);

    // ── 5. commit → CompleteMultipartUpload ──────────────────────────────
    const commit = await call(api, 'POST', `/uploads/${fileId}/commit`, { token });
    summary.line('complete', commit.status);
    if (commit.status !== 200) console.log(`   complete: ${detailOf(commit)}`);

    // ── 6. що лежить у сховищі ───────────────────────────────────────────
    const head = await storage.head(key);
    const sizeMatch = head?.size === SIZE ? 1 : 0;
    summary.line('size-match', sizeMatch);
    const md5 = createHash('md5').update(body).digest('hex');
    const etag = head?.etag ?? '';
    const suffix = /-(\d+)"?$/.exec(etag)?.[1];
    const etagMultipart = suffix === String(partCount) && !etag.includes(md5) ? 1 : 0;
    summary.line('etag-multipart', etagMultipart);
    // Страховка на випадок, коли resume так і не прийде: сховище саме скасує хвіст.
    const abortDays = (await storage.abortIncompleteAfterDays()) ?? 0;
    summary.line('lifecycle-abort-incomplete-days', abortDays);
    console.log(`   ETag ${etag}  ·  MD5 файла ${md5}  — суфікс -${suffix ?? '?'} = кількість частин, а не хеш вмісту`);

    summary.expect('intent=200 і multipart на 3 частини', intent.status === 200 && partCount === 3);
    summary.expect('процес №1 залив 2 частини і загинув від SIGKILL', sentBeforeCrash === 2 && first.signal === 'SIGKILL');
    summary.expect('після обриву у сховищі 2 частини, обʼєкта немає', partsAfterCrash === 2 && headAfterCrash === 404);
    summary.expect('resumed-parts=1 — процес №2 долив лише відсутню частину', resumed === 1);
    summary.expect('head-before-complete=404 — до Complete обʼєкта не існує', headBefore === 404);
    summary.expect('complete=200', commit.status === 200);
    summary.expect('size-match=1', sizeMatch === 1);
    summary.expect('etag-multipart=1 — ETag "…-3", не MD5', etagMultipart === 1);
    summary.expect('на бакеті є правило AbortIncompleteMultipartUpload', abortDays > 0);
  } finally {
    await api?.close();
    await purgeDemoFiles(dataSource, storage, DEMO).catch(() => undefined);
    await cleanup(dataSource, DEMO).catch(() => undefined);
    await dataSource.destroy();
    storage.destroy();
    await video.remove();
  }
  summary.finish();
}

/** UploadId живе в базі, а не в процесі клієнта: процес №1 загинув разом зі своєю памʼяттю. */
async function uploadIdOf(dataSource: DataSource, fileId: string): Promise<string> {
  const [row]: { upload_id: string | null }[] = await dataSource.query(`SELECT upload_id FROM files WHERE id = $1`, [fileId]);
  if (!row?.upload_id) throw new Error(`файл ${fileId}: немає upload_id`);
  return row.upload_id;
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
