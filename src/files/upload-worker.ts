import { open } from 'node:fs/promises';

/**
 * Клієнт завантаження — ОКРЕМИЙ процес ОС (#26), запускає його демо через fork.
 *
 * Окремий процес потрібен для двох доказів:
 *   • demo:upload — PUT робить процес, в оточенні якого немає ЖОДНОГО ключа:
 *     ні сховища, ні бази, ні JWT. Байти доїжджають, коли наш API вимкнено;
 *   • demo:multipart — процес гине від SIGKILL після другої частини: без
 *     finally, без Abort, без шансу прибрати за собою. Новий процес нічого
 *     не знає про старий і питає стан завантаження в API.
 *
 * Завдання й URL приходять по IPC, а не в argv: argv видно в `ps` будь-якому
 * користувачу машини, а presigned URL — це носій доступу.
 */

interface PartUrl {
  part_number: number;
  url: string;
}

export type WorkerJob =
  | { mode: 'put'; url: string; file: string; contentType: string }
  | { mode: 'parts'; file: string; partSize: number; parts: PartUrl[]; dieAfter?: number }
  | { mode: 'resume'; api: string; token: string; fileId: string; file: string };

export type WorkerReport =
  | { t: 'env'; secretVars: number }
  | { t: 'put'; status: number }
  | { t: 'part'; partNumber: number; status: number }
  | { t: 'resume'; uploaded: number[]; sent: number[] }
  | { t: 'done' }
  | { t: 'error'; message: string };

/** Повідомлення батьку; проміс — коли воно вже в каналі. Без цього SIGKILL чи disconnect зʼїли б останній звіт. */
const report = (message: WorkerReport): Promise<void> =>
  new Promise((resolve) => {
    if (!process.send) return resolve();
    process.send(message, () => resolve());
  });

function isJob(m: unknown): m is WorkerJob {
  return typeof m === 'object' && m !== null && 'mode' in m && (m.mode === 'put' || m.mode === 'parts' || m.mode === 'resume');
}

function isPartUrl(value: unknown): value is PartUrl {
  return typeof value === 'object' && value !== null && 'part_number' in value && typeof value.part_number === 'number' && 'url' in value && typeof value.url === 'string';
}

/** Відповідь `GET /uploads/{id}/parts` — лише поля, які потрібні клієнту. */
function partsReplyOf(json: unknown): { partSize: number; uploaded: number[]; parts: PartUrl[] } {
  if (
    typeof json !== 'object' ||
    json === null ||
    !('part_size' in json) ||
    typeof json.part_size !== 'number' ||
    !('uploaded' in json) ||
    !Array.isArray(json.uploaded) ||
    !('parts' in json) ||
    !Array.isArray(json.parts)
  ) {
    throw new Error(`несподівана відповідь /parts: ${JSON.stringify(json)}`);
  }
  const uploaded = json.uploaded.filter((n: unknown): n is number => typeof n === 'number');
  return { partSize: json.part_size, uploaded, parts: json.parts.filter(isPartUrl) };
}

/** Шматок файла з диска — частину читаємо з того місця, де вона лежить, а не весь файл у памʼять. */
async function slice(file: string, offset: number, length: number): Promise<Buffer> {
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function fileSize(file: string): Promise<number> {
  const handle = await open(file, 'r');
  try {
    return (await handle.stat()).size;
  } finally {
    await handle.close();
  }
}

async function putPart(file: string, size: number, partSize: number, part: PartUrl): Promise<number> {
  const offset = (part.part_number - 1) * partSize;
  const body = await slice(file, offset, Math.min(partSize, size - offset));
  const res = await fetch(part.url, { method: 'PUT', body });
  await res.body?.cancel();
  return res.status;
}

async function run(job: WorkerJob): Promise<void> {
  // Скільки змінних, схожих на секрет, бачить цей процес. Має бути 0:
  // put-offline=200 чесний, лише якщо PUT зробив процес без ключів.
  const secretVars = Object.keys(process.env).filter((name) => /STORAGE|AWS|SECRET|ACCESS_KEY|PASSWORD|DATABASE|JWT|REDIS/i.test(name));
  await report({ t: 'env', secretVars: secretVars.length });

  if (job.mode === 'put') {
    const body = await slice(job.file, 0, await fileSize(job.file));
    const res = await fetch(job.url, { method: 'PUT', body, headers: { 'content-type': job.contentType } });
    await res.body?.cancel();
    await report({ t: 'put', status: res.status });
    return;
  }

  if (job.mode === 'parts') {
    const size = await fileSize(job.file);
    let sent = 0;
    for (const part of job.parts) {
      await report({ t: 'part', partNumber: part.part_number, status: await putPart(job.file, size, job.partSize, part) });
      sent += 1;
      if (job.dieAfter !== undefined && sent >= job.dieAfter) {
        // Найгрубіша смерть, яку вміє процес: ядро знищує його без жодного
        // обробника. Рівно так помирає вкладка мобільного браузера чи под під OOM.
        process.kill(process.pid, 'SIGKILL');
        await new Promise(() => undefined);
      }
    }
    return;
  }

  // resume: стан — у сховищі. Процес нічого не знає про попередника, крім file_id.
  const size = await fileSize(job.file);
  const res = await fetch(`${job.api}/v1/uploads/${job.fileId}/parts`, { headers: { authorization: `Bearer ${job.token}` } });
  const json: unknown = await res.json();
  if (res.status !== 200) throw new Error(`GET /uploads/${job.fileId}/parts → ${res.status}: ${JSON.stringify(json)}`);
  const reply = partsReplyOf(json);
  const sent: number[] = [];
  for (const part of reply.parts) {
    const status = await putPart(job.file, size, reply.partSize, part);
    await report({ t: 'part', partNumber: part.part_number, status });
    if (status === 200) sent.push(part.part_number);
  }
  await report({ t: 'resume', uploaded: reply.uploaded, sent });
}

process.once('message', (message: unknown) => {
  const job = isJob(message) ? run(message) : Promise.reject(new Error(`невідоме завдання: ${JSON.stringify(message)}`));
  job
    .then(() => report({ t: 'done' }))
    .catch(async (err: unknown) => {
      process.exitCode = 1;
      await report({ t: 'error', message: err instanceof Error ? err.message : String(err) });
    })
    .finally(() => process.disconnect?.());
});
