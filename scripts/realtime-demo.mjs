// Ізоляція кімнат socket.io, виміряна, а не задекларована.
//
//   node scripts/realtime-demo.mjs               # A і B у різних кімнатах → B_RECEIVED=0
//   node scripts/realtime-demo.mjs --same-room   # обидва в кімнаті A      → B_RECEIVED=1
//
// Обидва режими — той самий код; різниться лише кімната другого клієнта. Якщо
// контрольний прогін теж дасть B_RECEIVED=0, скрипт нічого не вимірює.
//
// stdout — лише машинно-читані рядки KEY=VALUE, хід демо — у stderr.
// Код виходу: 0 — результат збігся з очікуваним, 1 — ні (ізоляцію порушено
// або подія не дійшла), 2 — демо не змогло відбутися (сервер, HTTP, join).
//
// Сервер має бути запущений (`npm run start:vault`), база — засіяна (`npm run
// seed`): з #24 усе під токеном, і демо логіниться сід-користувачами з
// паролем `marketplace-dev`. API_URL, BUYER_EMAIL і SEED_PASSWORD
// перевизначають адресу, покупця й пароль.
import { randomUUID } from 'node:crypto';
import { io } from 'socket.io-client';

const BASE = process.env.API_URL ?? 'http://localhost:3000';
// Власник замовлень — покупець із сіду (src/seed-data.ts); чужий — інший
// покупець звідти ж; статус замовлення міняє лише адмін.
const BUYER = process.env.BUYER_EMAIL ?? 'olena@marketplace.test';
const STRANGER = 'taras@marketplace.test';
const ADMIN = 'admin@marketplace.test';
const PASSWORD = process.env.SEED_PASSWORD ?? 'marketplace-dev';
const SAME_ROOM = process.argv.includes('--same-room');

const ACK_TIMEOUT_MS = 3000;
// Скільки чекаємо подію в A, і скільки ще слухаємо B після того, як A її
// отримав. Подія в B, якщо ізоляцію зламано, летить тим самим emit-ом, тож
// приходить за мілісекунди; секунда — запас, а не оцінка.
const DELIVERY_TIMEOUT_MS = 5000;
const SILENCE_MS = 1000;
const DEADLINE_MS = 20_000;

const log = (line) => console.error(`[demo] ${line}`);

class SetupError extends Error {}

// Скрипт завершується сам за будь-яких умов: мертвий сервер не має
// перетворити демо на процес, що висить вічно.
setTimeout(() => {
  log(`не вклались у ${DEADLINE_MS / 1000} с`);
  process.exit(2);
}, DEADLINE_MS).unref();

async function api(method, path, body, headers = {}, token) {
  let res;
  try {
    res = await fetch(`${BASE}/v1${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    throw new SetupError(`${method} ${path}: ${err.cause?.code ?? err.message} — сервер запущений?`);
  }
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

/** Access-токен сід-користувача. */
async function tokenOf(email) {
  const { status, json } = await api('POST', '/auth/login', { email, password: PASSWORD });
  if (status !== 200) throw new SetupError(`login ${email} → ${status} ${json?.detail ?? ''} — спершу npm run seed`);
  return json.access_token;
}

/** Нове замовлення покупця. Залишку у товару може не бути (409) — тоді наступний. */
async function createOrder(token) {
  const { status, json } = await api('GET', '/products?limit=50');
  if (status !== 200) throw new SetupError(`GET /products → ${status}`);
  for (const product of json.items) {
    const created = await api(
      'POST',
      '/orders',
      { items: [{ product_id: product.id, qty: 1 }] },
      { 'Idempotency-Key': randomUUID() },
      token,
    );
    if (created.status === 201) return created.json.id;
    if (created.status !== 409) throw new SetupError(`POST /orders → ${created.status} ${created.json?.detail ?? ''}`);
  }
  throw new SetupError('жодного товару в наявності — спершу npm run seed');
}

function connect(name, auth) {
  const socket = io(BASE, { auth, reconnectionAttempts: 3 });
  // Реконект — справа менеджера (одне зʼєднання на кілька namespace-ів), а не
  // сокета: на `socket.on('reconnect_attempt')` ця подія не прийде ніколи.
  socket.io.on('reconnect_attempt', (n) => log(`${name}: реконект, спроба ${n}`));
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', (err) => reject(new SetupError(`${name}: ${err.message} — сервер запущений?`)));
  });
}

/** join із ack: повертається, лише коли сервер уже поклав сокет у кімнату. */
async function join(socket, orderId) {
  try {
    return await socket.timeout(ACK_TIMEOUT_MS).emitWithAck('join', { order_id: orderId });
  } catch {
    throw new SetupError(`join ${orderId}: немає ack за ${ACK_TIMEOUT_MS} мс`);
  }
}

async function joinOrFail(name, socket, orderId) {
  const ack = await join(socket, orderId);
  if (!ack.ok) throw new SetupError(`${name}: join orders:${orderId} відхилено (${ack.error})`);
  // Після реконекту це вже інший сокет на сервері, і кімнати в нього немає:
  // socket.io відновлює зʼєднання, але не членство. Заходимо знову самі.
  socket.io.on('reconnect', () => join(socket, orderId).then((again) => log(`${name}: повторний join → ${again.ok}`)));
  return ack.room;
}

const sockets = [];

async function main() {
  const [buyer, strangerToken, admin] = [await tokenOf(BUYER), await tokenOf(STRANGER), await tokenOf(ADMIN)];
  const orderA = await createOrder(buyer);
  const orderB = await createOrder(buyer);
  const roomB = SAME_ROOM ? orderA : orderB;
  log(`режим: ${SAME_ROOM ? 'контрольний, обидва в кімнаті A' : 'ізоляція, різні кімнати'}`);

  const a = await connect('A', { token: buyer });
  const b = await connect('B', { token: buyer });
  sockets.push(a, b);

  // Перевірка власника: ні анонім, ні чужий у кімнату A не потрапляють.
  const anonymous = await connect('anon', {});
  const stranger = await connect('stranger', { token: strangerToken });
  sockets.push(anonymous, stranger);
  const refused = [await join(anonymous, orderA), await join(stranger, orderA)];
  log(`join orders:${orderA} без токена → ${refused[0].error ?? 'ПРИЙНЯТО'}, чужим → ${refused[1].error ?? 'ПРИЙНЯТО'}`);

  // Спершу ack від join — і лише потім зміна статусу. Інакше подія вилетить
  // раніше, ніж сервер поклав клієнта в кімнату, і «не отримав» означатиме
  // гонку, а не ізоляцію.
  log(`A → ${await joinOrFail('A', a, orderA)}, B → ${await joinOrFail('B', b, roomB)}`);

  const received = { A: 0, B: 0 };
  let resolveA;
  const gotA = new Promise((resolve) => (resolveA = resolve));
  a.on('order.status', (event) => {
    if (event.order_id !== orderA) return;
    received.A += 1;
    resolveA();
  });
  b.on('order.status', (event) => {
    if (event.order_id === orderA) received.B += 1;
  });

  const patched = await api('PATCH', `/orders/${orderA}`, { status: 'paid' }, {}, admin);
  if (patched.status !== 200) throw new SetupError(`PATCH /orders/${orderA} → ${patched.status} ${patched.json?.detail ?? ''}`);
  log(`замовлення ${orderA}: pending → paid`);

  await Promise.race([gotA, new Promise((resolve) => setTimeout(resolve, DELIVERY_TIMEOUT_MS))]);
  await new Promise((resolve) => setTimeout(resolve, SILENCE_MS));

  const A = received.A > 0 ? 1 : 0;
  const B = received.B > 0 ? 1 : 0;
  console.log(`A_RECEIVED=${A}`);
  console.log(`B_RECEIVED=${B}`);

  const strangersKeptOut = refused.every((ack) => !ack.ok);
  return A === 1 && B === (SAME_ROOM ? 1 : 0) && strangersKeptOut ? 0 : 1;
}

let code;
try {
  code = await main();
} catch (err) {
  // Будь-яка інша помилка — теж «демо не відбулось», а не «ізоляцію порушено»:
  // код 1 лишається тільки за виміряним результатом.
  log(err instanceof SetupError ? err.message : err.stack);
  code = 2;
}
for (const socket of sockets) socket.disconnect();
process.exit(code);
