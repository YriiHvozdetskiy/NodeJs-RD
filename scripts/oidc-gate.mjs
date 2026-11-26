#!/usr/bin/env node
// OIDC-гейт (#32): пускати джобу деплою чи ні — за ID-токеном, який виписав GitHub.
//
//   node scripts/oidc-gate.mjs --token-file <файл з JWT> --policy oidc/policy.json \
//        [--discovery-url <адреса openid-configuration>]
//
// Те саме, що робить хмара на sts:AssumeRoleWithWebIdentity, тільки тут
// «хмара» — ми. Порядок той самий, що на #24/#25 з нашими access-токенами:
//   1. discovery: openid-configuration за адресою з параметра → issuer і jwks_uri;
//   2. набір публічних ключів за jwks_uri, ключ — за kid із заголовка токена;
//   3. ПІДПИС: RS256 над `header.payload` цим ключем. Не зійшовся — далі не
//      читаємо нічого: умову не можна застосовувати до тексту, який будь-хто
//      міг написати сам (саме так LocalStack видає креденшели на підроблений JWT);
//   4. УМОВА з файла: iss, aud і sub — точним збігом, плюс exp/nbf.
//
// Гейт не знає, де його запустили. Адреса discovery, умова і токен приходять
// параметрами: у конвеєрі — справжній GitHub, у demo:oidc — локальний сервер
// із нашим власним ключем. Код перевірки один і той самий.
//
// stdout — рядки ключ=значення: sig-verified, policy-allow, oidc-iss/aud/sub.
// Сам токен не друкується ніколи — ні цілим, ні частиною.
// Код виходу: 0 — пускаємо, 1 — ні, 2 — гейт не зміг відпрацювати (теж «ні»).
import { createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

// Розбіжність годинників раннера й видавця. Більше — і протермінований токен
// жив би ще хвилини.
const CLOCK_SKEW_S = 60;

const out = (key, value) => console.log(`${key}=${value}`);
function deny(reason, code = 1) {
  out('policy-allow', 0);
  out('reason', reason);
  process.exit(code);
}

const { values: args } = parseArgs({
  options: {
    'token-file': { type: 'string' },
    policy: { type: 'string' },
    'discovery-url': { type: 'string' },
  },
});
if (!args['token-file'] || !args.policy) {
  console.error('usage: oidc-gate.mjs --token-file <jwt> --policy <policy.json> [--discovery-url <url>]');
  process.exit(2);
}

const policy = JSON.parse(readFileSync(args.policy, 'utf8'));
const algorithms = policy.algorithms ?? ['RS256'];
// Умова без sub — це «пускати будь-який репозиторій на GitHub»: підпис і aud
// у чужого токена такі самі. Тому порожній список — помилка умови, а не «усі».
// Шаблонів немає свідомо: лише точний збіг, кожен дозволений sub — окремим рядком.
if (typeof policy.issuer !== 'string' || typeof policy.audience !== 'string' ||
    !Array.isArray(policy.subjects) || policy.subjects.length === 0 ||
    policy.subjects.some((s) => typeof s !== 'string' || s.includes('*'))) {
  console.error(`oidc-gate: ${args.policy}: потрібні issuer, audience і непорожній subjects без шаблонів`);
  process.exit(2);
}

/** Ключі — лише по https; http дозволено тільки на loopback (локальний сервер ключів). */
function trustedTransport(raw) {
  const url = new URL(raw);
  if (url.protocol === 'https:') return url;
  if (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return url;
  throw new Error(`${raw}: ключі по ${url.protocol} підмінить будь-хто на маршруті`);
}

async function getJson(raw) {
  // redirect: 'error' — набір ключів не має «переїжджати» на іншу адресу непомітно.
  const res = await fetch(trustedTransport(raw), { redirect: 'error', signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`${raw}: HTTP ${res.status}`);
  return res.json();
}

const b64json = (part) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

// ── 1–2. Discovery і набір ключів ───────────────────────────────────────────
const discoveryUrl = args['discovery-url'] ?? `${policy.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`;
let jwks;
try {
  const discovery = await getJson(discoveryUrl);
  out('discovery-issuer', discovery.issuer);
  // Документ discovery має назвати себе тим самим видавцем, якому ми довіряємо.
  // Інакше ключі в ньому — чиїсь інші, і підпис ними нічого не доводить.
  if (discovery.issuer !== policy.issuer) {
    out('sig-verified', 0);
    deny('discovery-issuer-mismatch');
  }
  out('jwks-uri', discovery.jwks_uri);
  jwks = await getJson(discovery.jwks_uri);
  out('jwks-keys', jwks.keys?.length ?? 0);
} catch (err) {
  console.error(`oidc-gate: ${err.message}`);
  out('sig-verified', 0);
  deny('jwks-unavailable', 2);
}

// ── 3. Підпис ───────────────────────────────────────────────────────────────
const token = readFileSync(args['token-file'], 'utf8').trim();
const parts = token.split('.');
let header;
try {
  header = parts.length === 3 ? b64json(parts[0]) : undefined;
} catch {
  header = undefined;
}
if (typeof header !== 'object' || header === null) {
  out('sig-verified', 0);
  deny('malformed-token');
}
out('kid', header.kid);

// Алгоритм — зі списку умови, а не «який написано в заголовку». `alg: none`
// або HS256 з публічним ключем як секретом — класичні підробки, і обидві
// відсікаються тут, до будь-якої криптографії.
if (!algorithms.includes(header.alg)) {
  out('sig-verified', 0);
  deny(`alg-not-allowed:${header.alg}`);
}
const jwk = (jwks.keys ?? []).find((k) => k.kid === header.kid && k.kty === 'RSA');
if (!jwk) {
  out('sig-verified', 0);
  deny('unknown-kid');
}

/** RS256 = RSASSA-PKCS1-v1_5 + SHA-256; для RSA-ключа це паддінг за замовчуванням. */
function signatureMatches() {
  try {
    return verify(
      'sha256',
      Buffer.from(`${parts[0]}.${parts[1]}`),
      createPublicKey({ key: jwk, format: 'jwk' }),
      Buffer.from(parts[2], 'base64url'),
    );
  } catch {
    // Битий ключ у наборі або підпис не тієї довжини — теж «не зійшовся».
    return false;
  }
}
const signatureOk = signatureMatches();
out('sig-verified', signatureOk ? 1 : 0);
if (!signatureOk) deny('bad-signature');

// ── 4. Умова — лише над перевіреним payload ─────────────────────────────────
const claims = b64json(parts[1]);
const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
out('oidc-iss', claims.iss);
out('oidc-aud', auds.join(','));
out('oidc-sub', claims.sub);

const now = Math.floor(Date.now() / 1000);
const reasons = [];
if (typeof claims.exp !== 'number' || claims.exp <= now - CLOCK_SKEW_S) reasons.push('expired');
if (typeof claims.nbf === 'number' && claims.nbf > now + CLOCK_SKEW_S) reasons.push('not-yet-valid');
if (claims.iss !== policy.issuer) reasons.push('iss');
if (!auds.includes(policy.audience)) reasons.push('aud');
// Той самий рядок, що в trust policy ролі AWS: без нього iss, aud і підпис
// зелені в будь-якого репозиторію на GitHub.
if (!policy.subjects.includes(claims.sub)) reasons.push('sub');
if (typeof claims.exp === 'number') out('oidc-expires-in-seconds', claims.exp - now);

if (reasons.length > 0) deny(reasons.join(','));
out('policy-allow', 1);
