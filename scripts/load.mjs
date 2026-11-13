// Генератор навантаження для demo:rollout (#28).
//
//   node scripts/load.mjs <url> <out-file> [rps=200] [max-seconds=600]
//
// Пише РЯДОК НА КОЖЕН ЗАПИТ і нічого не рахує: висновки робить той, хто читає
// файл. Рядок — код відповіді (`200`). Якщо відповіді не було взагалі — `000`,
// причина від мережевого стеку (ECONNREFUSED, ECONNRESET, ETIMEDOUT…) і момент
// у мс epoch: за ним демо зіставляє збій із фазою rollout. Ми ходимо в NodePort
// напряму, тож збій виглядає саме так, а не як 502/503 — їх дав би балансувальник.
//
// Кожен запит — нове TCP-зʼєднання (agent: false), як у curl: keep-alive
// приклеїв би генератор до одного пода, і rolling update він би просто не помітив.
//
// Темп — фіксований, 200 запитів/с за замовчуванням, як у curl-генератора лекції.
// Без обмеження генератор відкривав ~1300 нових зʼєднань/с, і це вимір самого
// TCP, а не rollout: закрите зʼєднання тримає свій порт у TIME_WAIT 60 с, а
// ~28 тис. клієнтських портів однієї IP закінчуються за ~20 с. Новий SYN тоді
// інколи влучає в чужий TIME_WAIT і губиться, ядро повторює його через 1 с, потім
// ще через 2 с — і запит не вкладається в таймаут. Виміряно без жодного rollout:
// 6 таймаутів на 27 тис. запитів на повній швидкості, 0 на 22,5 тис. при 250/с.
//
// Зупинка — файл <out-file>.stop (його створює демо) або max-seconds.
import { createWriteStream, existsSync } from 'node:fs';
import http from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';

const [url, out, rpsArg = '200', maxSecondsArg = '600'] = process.argv.slice(2);
if (!url || !out) {
  console.error('usage: node scripts/load.mjs <url> <out-file> [rps] [max-seconds]');
  process.exit(2);
}
// Потоків із запасом: запит, що чекає повтору SYN, не має зупиняти темп решти.
const WORKERS = 8;
const interval = 1000 / Number(rpsArg);
let nextAt = Date.now();
const deadline = Date.now() + Number(maxSecondsArg) * 1000;
const stopFile = `${out}.stop`;
const sink = createWriteStream(out, { flags: 'w' });

function once() {
  return new Promise((resolve) => {
    const failed = (err) => resolve(`000 ${err.code ?? err.message} ${Date.now()}`);
    const req = http.get(url, { agent: false, timeout: 2000 }, (res) => {
      res.resume();
      res.on('end', () => resolve(String(res.statusCode)));
      res.on('error', failed);
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', failed);
  });
}

let stopped = false;
async function worker() {
  while (!stopped) {
    // Спільний розклад на всі потоки: кожен бере наступний вільний слот.
    const now = Date.now();
    const slot = Math.max(nextAt, now);
    nextAt = slot + interval;
    if (slot > now) await sleep(slot - now);
    if (stopped) break;
    sink.write(`${await once()}\n`);
  }
}

// Прапорець зупинки перевіряється раз на 100 мс, а не перед кожним запитом.
const timer = setInterval(() => {
  if (Date.now() > deadline || existsSync(stopFile)) stopped = true;
}, 100);

await Promise.all(Array.from({ length: WORKERS }, worker));
clearInterval(timer);
sink.end();
