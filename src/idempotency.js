'use strict';

const crypto = require('node:crypto');

// Сховище ключів ідемпотентності. У памʼяті — і це чесно названа межа:
// після рестарту процесу той самий ключ створить замовлення ВДРУГЕ.
// Спільне сховище (Redis `SET NX EX 86400`) приїде разом з #23.
const TTL_MS = 24 * 60 * 60 * 1000;
const store = new Map();

function fingerprint(body) {
  // Зберігаємо відпечаток тіла, а не тіло: питання лише «те саме чи інше».
  // Чесне обмеження: JSON.stringify залежить від порядку ключів. Клієнт, який
  // на retry серіалізує те саме тіло в іншому порядку, отримає 422 на рівному
  // місці. Промислове рішення — канонічний JSON (RFC 8785); приїде на #14.
  return crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

function get(key) {
  const entry = store.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    return undefined;
  }
  return entry;
}

const markInFlight = (key, fp) =>
  store.set(key, { state: 'in-flight', fingerprint: fp, expiresAt: Date.now() + TTL_MS });

const markDone = (key, fp, response) =>
  store.set(key, { state: 'done', fingerprint: fp, response, expiresAt: Date.now() + TTL_MS });

// Обробник упав — ключ мусить забутись, інакше клієнт застрягне на 409 назавжди,
// хоча замовлення так і не створилось.
const forget = (key) => store.delete(key);

/**
 * Рішення про долю запиту з цим Idempotency-Key.
 * @param {object|undefined} entry — те, що лежить у сховищі під ключем (або undefined)
 * @param {string} fp — відпечаток тіла ЦЬОГО запиту
 * @returns {'proceed'|'replay'|'in-flight'|'mismatch'}
 */
function decide(entry, fp) {
  // Ключ вільний: або не бачили ніколи, або TTL уже вийшов. Прострочені записи
  // відсіює get(), тож сюди `entry` доходить лише живим — шукати тут перевірку
  // часу не треба.
  if (!entry) return 'proceed';

  // Відпечаток тіла перевіряємо ПЕРШИМ — раніше за стан. Це принципово, і ось
  // чому це взагалі законно: markInFlight() пише fingerprint ДО того, як
  // побіжить обробник. Тому навіть у стані 'in-flight' відпечаток уже
  // достовірний, і порівнювати з ним можна.
  //
  // Якби ми писали fingerprint лише в markDone(), у 'in-flight' його ще не
  // існувало б — і тоді порядок був би зворотний, бо порівнювати було б нічого.
  // Тобто порядок цих двох if — не смак, а наслідок того, КОЛИ ми пишемо
  // відпечаток.
  //
  // А чому mismatch важливіший за in-flight, коли обидва справдились:
  // «тіло інше» — це остаточний факт про клієнта, він не зміниться від
  // очікування. «Ще в польоті» — тимчасовий стан сервера. Якби ми віддали 409,
  // клієнт повторював би той самий запит, який НІКОЛИ не пройде: після
  // завершення першого він усе одно отримає 422, просто витративши N спроб.
  // 422 одразу каже правду й економить ці спроби.
  if (entry.fingerprint !== fp) return 'mismatch';

  // Тіло те саме, але перший запит із цим ключем ще не завершився. Відповіді
  // ще не існує — віддавати нічого. Клієнт мусить повторити ТОЙ САМИЙ запит.
  if (entry.state === 'in-flight') return 'in-flight';

  // Лишився один випадок: state === 'done' і тіло те саме. Відповідь у сховищі
  // готова — віддаємо її, обробник не запускаємо.
  return 'replay';
}

module.exports = { fingerprint, get, markInFlight, markDone, forget, decide };
