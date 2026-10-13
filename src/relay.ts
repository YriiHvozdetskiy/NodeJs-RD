import { EventPublisher } from './messaging/publisher';
import { runRelayProcess } from './outbox/relay-process';

/**
 * Relay outbox окремим процесом (#22). Той самий цикл, що вбудований у
 * застосунок (src/outbox/outbox-relay.service.ts), — для масштабування окремо
 * від API.
 *
 *   npm run relay    ≡ bash scripts/with-secrets.sh dev node dist/relay.js
 *
 * Скільки relay не запусти, кожен рядок винесе один: SKIP LOCKED і оренда
 * роздають їм різні рядки. Дубль можливий лише після падіння між publish і
 * позначкою published_at.
 */
runRelayProcess((brokerUrl) => new EventPublisher(async () => brokerUrl)).catch((err: unknown) => {
  console.error(`[relay ${process.pid}] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
