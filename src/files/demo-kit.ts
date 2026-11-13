import { fork } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { HeadObjectCommand, ListMultipartUploadsCommand, ListObjectsV2Command, S3ServiceException } from '@aws-sdk/client-s3';
import type { DataSource } from 'typeorm';
import { demoDomain } from '../auth/demo-kit';
import type { ObjectStorage } from './object-storage';
import type { WorkerJob, WorkerReport } from './upload-worker';

/**
 * Спільне для demo:upload, demo:multipart і demo:cdn (#26). Як і демо
 * #22–#24, кожне:
 *   1. саме приводить стан до чистого — і на старті, і в кінці: бакет є,
 *      обʼєктів і незавершених завантажень попереднього прогону немає;
 *   2. друкує підсумок рядками ключ=число;
 *   3. саме перевіряє інваріанти — код виходу ≠ 0, якщо порушено.
 */

export interface WorkerRun {
  reports: WorkerReport[];
  code: number | null;
  signal: NodeJS.Signals | null;
}

function isReport(m: unknown): m is WorkerReport {
  return typeof m === 'object' && m !== null && 't' in m && typeof m.t === 'string';
}

/**
 * Клієнт завантаження окремим процесом (src/files/upload-worker.ts).
 * Оточення за замовчуванням — лише PATH: жодного ключа сховища, бази чи JWT.
 */
export function runWorker(job: WorkerJob, env: NodeJS.ProcessEnv = { PATH: process.env.PATH }, timeoutMs = 60_000): Promise<WorkerRun> {
  const child = fork(path.join(__dirname, 'upload-worker.js'), { env, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  const reports: WorkerReport[] = [];
  child.on('message', (m) => {
    if (isReport(m)) reports.push(m);
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`клієнт завантаження (${job.mode}) не завершився за ${timeoutMs} мс`));
    }, timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ reports, code, signal });
    });
    child.send(job);
  });
}

/**
 * Чи слухає хтось порт. Сирий TCP-сокет, а не fetch: глобальний fetch тримає
 * пул зʼєднань на (host, port), і після зупинки сервера міг би дістати з пулу
 * мертвий сокет і висіти до таймауту. connect або відмовляє одразу
 * (ECONNREFUSED → 0), або зʼєднується (→ 1).
 */
export function portAlive(url: string): Promise<0 | 1> {
  const { hostname, port } = new URL(url);
  return new Promise((resolve) => {
    const socket = connect({ host: hostname, port: Number(port) });
    socket.setTimeout(1_000);
    socket.once('connect', () => {
      socket.destroy();
      resolve(1);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(0);
    });
    socket.once('error', () => resolve(0));
  });
}

/** HTTP-статус HeadObject як число: 200 — обʼєкт є, 404 — немає. */
export async function headStatus(storage: ObjectStorage, key: string): Promise<number> {
  try {
    await storage.s3.send(new HeadObjectCommand({ Bucket: storage.bucket, Key: key }));
    return 200;
  } catch (err) {
    if (err instanceof S3ServiceException) return err.$metadata.httpStatusCode ?? 0;
    throw err;
  }
}

/**
 * Прибрати все під префіксом: спершу незавершені multipart (вони тарифікуються,
 * хоча обʼєкта немає і в листингу обʼєктів їх не видно), потім обʼєкти.
 * Листинг тут доречний: це прибирання власного префікса демо, а не «покажи
 * файли користувача» — для того є таблиця files.
 */
export async function purgePrefix(storage: ObjectStorage, prefix: string): Promise<{ aborted: number; deleted: number }> {
  let aborted = 0;
  let keyMarker: string | undefined;
  let uploadIdMarker: string | undefined;
  for (;;) {
    const page = await storage.s3.send(
      new ListMultipartUploadsCommand({ Bucket: storage.bucket, Prefix: prefix, KeyMarker: keyMarker, UploadIdMarker: uploadIdMarker }),
    );
    for (const upload of page.Uploads ?? []) {
      if (!upload.Key || !upload.UploadId) continue;
      await storage.abortMultipart(upload.Key, upload.UploadId);
      aborted += 1;
    }
    if (!page.IsTruncated) break;
    keyMarker = page.NextKeyMarker;
    uploadIdMarker = page.NextUploadIdMarker;
  }

  let deleted = 0;
  let token: string | undefined;
  for (;;) {
    const page = await storage.s3.send(new ListObjectsV2Command({ Bucket: storage.bucket, Prefix: prefix, ContinuationToken: token }));
    for (const object of page.Contents ?? []) {
      if (!object.Key) continue;
      await storage.delete(object.Key);
      deleted += 1;
    }
    if (!page.IsTruncated) break;
    token = page.NextContinuationToken;
  }
  return { aborted, deleted };
}

/**
 * Файли демо-користувачів цього демо: обʼєкти й завантаження під їхніми
 * префіксами, потім рядки files. Викликати ДО auth-cleanup: files → users
 * стоїть на RESTRICT, і користувача з файлами база видалити не дасть.
 */
export async function purgeDemoFiles(dataSource: DataSource, storage: ObjectStorage, demo: string): Promise<void> {
  const owners: { id: string }[] = await dataSource.query(`SELECT id FROM users WHERE email LIKE '%@' || $1`, [demoDomain(demo)]);
  for (const owner of owners) await purgePrefix(storage, `uploads/${owner.id}/`);
  await dataSource.query(`DELETE FROM files WHERE owner_id IN (SELECT id FROM users WHERE email LIKE '%@' || $1)`, [demoDomain(demo)]);
}

/** Тимчасовий файл на диску клієнта: воркер читає частини з нього, як справжній клієнт — з диска. */
export async function tempFile(name: string, body: Buffer): Promise<{ file: string; remove(): Promise<void> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'demo-files-'));
  const file = path.join(dir, name);
  await writeFile(file, body);
  return { file, remove: () => rm(dir, { recursive: true, force: true }) };
}

/** JSON-поле відповіді API або undefined — демо не довіряє формі відповіді наосліп. */
export function field(json: unknown, name: string): unknown {
  return typeof json === 'object' && json !== null ? Reflect.get(json, name) : undefined;
}
