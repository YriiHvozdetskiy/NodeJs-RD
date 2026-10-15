import 'reflect-metadata';
import { startApi, type PodReport } from './redis/demo-kit';

/**
 * Один «под» для demo:ratelimit: справжній AppModule у власному процесі ОС,
 * зі своїм зʼєднанням із Redis і своїм екземпляром лімітера. Батьківський
 * процес дізнається адресу через IPC і зупиняє под сигналом SIGTERM.
 */
async function main(): Promise<void> {
  const api = await startApi();
  const report: PodReport = { t: 'ready', url: api.url, pid: process.pid };
  process.send?.(report);

  process.once('SIGTERM', () => {
    void api.close().finally(() => process.exit(0));
  });
}

main().catch((err: unknown) => {
  console.error(`[pod ${process.pid}] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
