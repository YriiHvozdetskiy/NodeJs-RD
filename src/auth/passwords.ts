import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/**
 * Хеш пароля — scrypt із `node:crypto`. Він повільний навмисно і вимагає
 * памʼяті: перебір вкраденого дампу коштує атакувальнику 32 MiB і десятки
 * мілісекунд на КОЖНУ спробу. Argon2id — рекомендація OWASP номер один, але
 * це нативний біндинг із node-gyp (pnpm-workspace.yaml, allowBuilds); scrypt
 * OWASP приймає як заміну і він уже є в Node.
 *
 * Формат рядка самоописний: `scrypt$N$r$p$salt$hash`. Параметри живуть поруч
 * із хешем, тож їх можна посилити для нових паролів, не зламавши старі.
 */
const PARAMS = { N: 2 ** 15, r: 8, p: 1 } as const;
const KEY_LENGTH = 32;
/** Межа памʼяті scrypt: 128 · N · r = 32 MiB, дефолтних 32 MiB впритул не вистачає. */
const MAX_MEM = 64 * 1024 * 1024;

function derive(password: string, salt: Buffer, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFC'), salt, KEY_LENGTH, { ...options, maxmem: MAX_MEM }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

export async function hashPassword(password: string, salt: Buffer = randomBytes(16)): Promise<string> {
  const key = await derive(password, salt, PARAMS);
  return ['scrypt', PARAMS.N, PARAMS.r, PARAMS.p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

/**
 * Хеш, із яким порівнюється пароль, коли такого email немає. Без нього
 * «немає користувача» відповідало б за мікросекунди, а «не той пароль» — за
 * десятки мілісекунд, і час відповіді видавав би, чий email зареєстрований.
 */
let dummy: Promise<string> | undefined;
export function dummyHash(): Promise<string> {
  dummy ??= hashPassword('dummy-password-for-timing');
  return dummy;
}

/**
 * Порівняння за сталий час: `===` на буферах зупиняється на першому
 * різному байті, і за часом відповіді можна підбирати хеш побайтово.
 * Рядок не нашого формату (`!` у гостя, заглушка старого сіду) — просто false.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, saltB64, keyB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, 'base64url');
  const actual = await derive(password, Buffer.from(saltB64, 'base64url'), { N: Number(n), r: Number(r), p: Number(p) });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
