import { AbstractLogger, type LogLevel, type LogMessage } from 'typeorm';

/**
 * Логер TypeORM, який рахує SQL-запити. N+1 у коді не видно — лише в лозі,
 * тому доказ «до/після» — це число з цього лічильника, а не відчуття.
 *
 * Рахується кожне повідомлення типу 'query' — тобто кожен реальний round-trip
 * до Postgres, включно з BEGIN/COMMIT, якщо вони є.
 */
export class QueryCountLogger extends AbstractLogger {
  count = 0;
  /** Друкувати SQL у консоль. Вмикаємо точково, щоб показати сам N+1. */
  echo = false;

  reset(): void {
    this.count = 0;
  }

  protected writeLog(level: LogLevel, messages: LogMessage | LogMessage[]): void {
    for (const message of Array.isArray(messages) ? messages : [messages]) {
      if (message.type !== 'query') continue;
      this.count += 1;
      if (this.echo) {
        const sql = String(message.message).replace(/\s+/g, ' ');
        console.log(`  SQL#${this.count}: ${sql.length > 140 ? `${sql.slice(0, 140)}…` : sql}`);
      }
    }
  }
}
