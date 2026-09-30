import * as path from 'node:path';
import { readFile } from 'node:fs/promises';

/**
 * Адреса брокера в тому самому форматі, що й адреса бази (#11): у конфігу —
 * `amqp://user@host:port` без пароля, пароль — у файлі-секреті.
 *
 * Два входи, одна функція:
 *   • застосунок читає BROKER_URL з .env без пароля і BROKER_PASSWORD_FILE;
 *   • CLI (споживач, демо) отримує від scripts/with-secrets.sh уже повний URL —
 *     так само, як грейдер під SKIP_VAULT=1 експортує `amqp://app:app@…`.
 * Пароль у самому URL має пріоритет: файл читається лише тоді, коли його там
 * немає.
 */
export async function withBrokerPassword(url: string, passwordFile: string): Promise<string> {
  const parsed = new URL(url);
  if (parsed.password) return url;
  parsed.password = encodeURIComponent((await readFile(path.resolve(passwordFile), 'utf8')).trim());
  return parsed.toString();
}

/**
 * HTTP API management-плагіна (#19): через нього споживач вішає політику DLX.
 * AMQP-протокол політик не вміє — це налаштування брокера, а не повідомлень.
 *
 * Хост і креденшели — ті самі, що в BROKER_URL; порт — стоковий 15672 з
 * docker-compose.yml. BROKER_MANAGEMENT_URL (`http://host:port/api`) — для
 * брокера, де API живе деінде: інший порт, TLS на 15671, окремий хост.
 * vhost «/» у шляху API пишеться як %2F.
 */
export interface ManagementApi {
  base: string;
  authorization: string;
  vhost: string;
}

const MANAGEMENT_PORT = 15672;

export function managementApi(brokerUrl: string, override = process.env.BROKER_MANAGEMENT_URL): ManagementApi {
  const url = new URL(brokerUrl);
  const credentials = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
  const vhost = decodeURIComponent(url.pathname.replace(/^\//, '')) || '/';
  return {
    base: override?.replace(/\/$/, '') || `http://${url.hostname}:${MANAGEMENT_PORT}/api`,
    authorization: `Basic ${Buffer.from(credentials).toString('base64')}`,
    vhost: encodeURIComponent(vhost),
  };
}
