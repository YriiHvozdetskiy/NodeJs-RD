/**
 * Усі числа завантаження в одному місці (#26). Кожне або межа S3, або
 * виведене з неї та з одного припущення про мережу клієнта. Обґрунтування
 * словами — README, розділ Files.
 */

const KiB = 1024;
const MiB = 1024 * KiB;
const GiB = 1024 * MiB;

// ─── Межі протоколу S3 (не наш вибір) ────────────────────────────────────────

/** Найменша частина multipart. Діє на всі частини, крім останньої: інакше Complete → EntityTooSmall. */
export const S3_MIN_PART_SIZE = 5 * MiB;
/** Найбільше частин в одному завантаженні. */
export const S3_MAX_PARTS = 10_000;
/** Найбільший обʼєкт, який S3 приймає одним PUT. */
export const S3_MAX_SINGLE_PUT = 5 * GiB;

// ─── Мережа клієнта (наше припущення) ────────────────────────────────────────

/**
 * Повільний мобільний аплінк, під який рахуються строки: 1 Мбіт/с = 125 000 Б/с.
 * На швидшій мережі URL просто живе довше, ніж треба.
 */
const SLOW_UPLINK_BYTES_PER_SEC = 125_000;

/**
 * Від відповіді intent до першого байта PUT: клієнт дочитує відповідь,
 * готує тіло, переживає один ретрай. Хвилини досить для форми з аватаркою.
 */
const HANDOFF_SEC = 60;

/**
 * Стеля строку presigned. Технічна межа SigV4 — 7 діб, але URL помирає разом
 * із креденшелами, якими підписаний. У проді сервіс ходить у S3 під роллю, і
 * STS видає її креденшели на годину за замовчуванням. Довший строк на
 * машині розробника з довгоживучими ключами «працює», а в проді — ні.
 */
const MAX_URL_TTL_SEC = 3600;

/** Строк presigned GET для `GET /files/{id}` → 302: клієнт іде за редіректом одразу. */
export const DOWNLOAD_URL_TTL_SEC = 60;

/**
 * Скільки живе presigned URL на завантаження `size` байтів: час передачі на
 * повільному аплінку плюс хвилина на передачу естафети, не більше години.
 *
 * Presigned не можна відкликати: у нього немає ні jti, ні реєстру. Тому
 * строк — єдиний важіль, і він короткий настільки, наскільки дозволяє сценарій.
 * Файл 20 МіБ: 168 + 60 = 228 с. Аватарка на 200 КіБ: 2 + 60 = 62 с.
 * Завантаження, якому години не вистачило, не губиться: стан частин лежить
 * у сховищі, і `GET /uploads/{id}/parts` підпише свіжі URL на те, чого бракує.
 */
export function uploadUrlTtlSec(size: number): number {
  return Math.min(MAX_URL_TTL_SEC, HANDOFF_SEC + Math.ceil(size / SLOW_UPLINK_BYTES_PER_SEC));
}

// ─── Multipart ───────────────────────────────────────────────────────────────

/**
 * Розмір частини: не менше мінімуму S3 і не менше файл / 10 000 — інакше
 * частин стане більше за ліміт. Округлено вгору до цілого МіБ.
 *
 * Мінімум, а не більше, свідомо: частина — це одиниця відновлення. Після обриву
 * клієнт доливає частину з нуля, тож дрібніша частина — менше перезаливу.
 * Межа 10 000 вмикається лише на файлах понад 48,8 ГіБ (10 000 × 5 МіБ).
 * Бібліотека з жорсткими 5 МіБ на такому файлі впала б на 10 001-й частині.
 */
export function partSizeFor(size: number): number {
  return Math.max(S3_MIN_PART_SIZE, Math.ceil(size / S3_MAX_PARTS / MiB) * MiB);
}

export function partCountFor(size: number): number {
  return Math.ceil(size / partSizeFor(size));
}

/** Розмір частини `n` (1-based): усі повні, остання — залишок. */
export function expectedPartSize(size: number, partNumber: number): number {
  const partSize = partSizeFor(size);
  return Math.min(partSize, size - (partNumber - 1) * partSize);
}

/**
 * Поріг multipart: дві мінімальні частини, 10 МіБ.
 *
 * Multipart коштує зайвих запитів: Create, Complete і підпис на кожну частину.
 * Окупається він тим, що після обриву доливається одна частина, а не файл.
 * До 10 МіБ multipart дав би щонайбільше дві частини, і обрив коштував би до
 * половини файла — майже стільки ж, скільки звичайний повтор PUT. Вище порога
 * частин щонайменше три, і обрив коштує не більше третини.
 */
export const MULTIPART_THRESHOLD = 2 * S3_MIN_PART_SIZE;

// ─── Allowlist типів ─────────────────────────────────────────────────────────

/**
 * Що можна завантажити. Розширення ключа береться ЗВІДСИ, за contentType, а не
 * з filename клієнта: filename — це рядок від клієнта, і `../../etc/passwd`
 * у ключі означав би право писати за будь-яким шляхом у бакеті.
 *
 * `magic` — перші байти файла. Content-Type від клієнта — це лише його слова:
 * commit читає початок обʼєкта і звіряє. Без цього «image/png» з HTML усередині
 * роздавався б з нашого домену як сторінка — збережений XSS.
 */
interface AllowedType {
  ext: string;
  maxSize: number;
  magic(head: Buffer): boolean;
}

const startsWith = (head: Buffer, signature: string | number[], offset = 0): boolean => {
  const bytes = typeof signature === 'string' ? Buffer.from(signature, 'latin1') : Buffer.from(signature);
  return head.length >= offset + bytes.length && head.subarray(offset, offset + bytes.length).equals(bytes);
};

export const ALLOWED_TYPES = {
  // Фото товарів і аватарки.
  'image/jpeg': { ext: 'jpg', maxSize: 20 * MiB, magic: (h) => startsWith(h, [0xff, 0xd8, 0xff]) },
  'image/png': { ext: 'png', maxSize: 20 * MiB, magic: (h) => startsWith(h, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  'image/webp': { ext: 'webp', maxSize: 20 * MiB, magic: (h) => startsWith(h, 'RIFF') && startsWith(h, 'WEBP', 8) },
  // Документи продавця: сертифікати, інструкції.
  'application/pdf': { ext: 'pdf', maxSize: 50 * MiB, magic: (h) => startsWith(h, '%PDF-') },
  // Відео товару — сценарій, де multipart потрібен по-справжньому.
  'video/mp4': { ext: 'mp4', maxSize: GiB, magic: (h) => startsWith(h, 'ftyp', 4) },
} as const satisfies Record<string, AllowedType>;

export type AllowedContentType = keyof typeof ALLOWED_TYPES;

/** Скільки байтів початку файла читає commit, щоб звірити сигнатуру. */
export const MAGIC_BYTES = 16;

export function isAllowedContentType(value: string): value is AllowedContentType {
  return Object.hasOwn(ALLOWED_TYPES, value);
}
