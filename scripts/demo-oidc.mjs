#!/usr/bin/env node
// demo:oidc (#32) — той самий гейт, що стоїть у конвеєрі, на токенах, підписаних тут.
//
//   npm run demo:oidc
//
// Справжній токен GitHub живе хвилини й у репо не кладеться. Тому демо:
//   1. генерує RSA-пару — у памʼяті, на диск і в репо приватний ключ не потрапляє;
//   2. піднімає на 127.0.0.1 свій «видавець»: openid-configuration і JWKS із
//      публічною половиною. issuer у документі — той самий, що в oidc/policy.json:
//      гейт перевіряє не адресу, з якої взяв ключі, а що документ назвав себе
//      довіреним видавцем, а підпис зійшовся з його ключем;
//   3. підписує токени й проганяє кожен через scripts/oidc-gate.mjs з умовою
//      oidc/policy.json — тією самою, що в конвеєрі.
//
//   case            що в токені                                   очікуємо sig allow
//   green           дозволений sub, наш ключ                                     1  1
//   foreign-sub     sub чужого репозиторію, підпис і aud коректні               1  0
//   bad-signature   payload green, зіпсований підпис                             0  0
//   unsigned        alg: none, підпису немає (на такому LocalStack дає STS)      0  0
//
// foreign-sub — головний: усе, крім sub, у нього справжнє. «Ні» тут каже лише
// рядок subjects в умові. Приберіть його — і гейт пустить будь-кого.
//
// Мережа не потрібна: усе на loopback. Код виходу 0 — усі випадки дали
// очікуване; 1 — хоч один ні.
import { spawn } from 'node:child_process';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const POLICY = path.join(ROOT, 'oidc/policy.json');
const policy = JSON.parse(readFileSync(POLICY, 'utf8'));

const work = mkdtempSync(path.join(process.env.TMPDIR ?? tmpdir(), 'demo-oidc-'));
process.on('exit', () => rmSync(work, { recursive: true, force: true }));

// ── 1. Ключ видавця ─────────────────────────────────────────────────────────
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const kid = `demo-${randomUUID().slice(0, 8)}`;
const jwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' };

// ── 2. Локальний видавець: discovery + JWKS ─────────────────────────────────
const server = createServer((req, res) => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const body =
    req.url === '/.well-known/openid-configuration'
      ? { issuer: policy.issuer, jwks_uri: `${base}/.well-known/jwks`, id_token_signing_alg_values_supported: ['RS256'] }
      : req.url === '/.well-known/jwks'
        ? { keys: [jwk] }
        : null;
  res.writeHead(body ? 200 : 404, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body ?? { error: 'not found' }));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const discoveryUrl = `http://127.0.0.1:${server.address().port}/.well-known/openid-configuration`;

// ── 3. Токени ───────────────────────────────────────────────────────────────
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
function signJwt(payload) {
  const head = b64({ alg: 'RS256', typ: 'JWT', kid });
  const body = b64(payload);
  const signature = sign('sha256', Buffer.from(`${head}.${body}`), privateKey).toString('base64url');
  return `${head}.${body}.${signature}`;
}

const now = Math.floor(Date.now() / 1000);
// Claims — як у справжнього токена джоби з `environment: staging`.
const green = {
  iss: policy.issuer,
  aud: policy.audience,
  sub: policy.subjects[0],
  environment: 'staging',
  ref: 'refs/pull/1/merge',
  event_name: 'pull_request',
  jti: randomUUID(),
  iat: now,
  nbf: now - 5,
  exp: now + 300,
};
// Чужий репозиторій у тому самому форматі sub: інший власник, інший репо, ті самі
// environment і aud. Підписано тим самим ключем видавця — як і будь-який токен GitHub.
const foreign = { ...green, sub: 'repo:attacker@31337/NodeJs-RD@7777777:environment:staging', jti: randomUUID() };

const greenJwt = signJwt(green);
// Зіпсований підпис: payload той самий, що в green, але підпис підписано
// для іншого вмісту — байти валідні, просто не від цього тексту.
const [gh, gp] = greenJwt.split('.');
const badSignature = `${gh}.${gp}.${signJwt({ ...green, sub: 'другий текст' }).split('.')[2]}`;
const unsigned = `${b64({ alg: 'none', typ: 'JWT' })}.${gp}.`;

const cases = [
  { name: 'green', jwt: greenJwt, expect: [1, 1] },
  { name: 'foreign-sub', jwt: signJwt(foreign), expect: [1, 0] },
  { name: 'bad-signature', jwt: badSignature, expect: [0, 0] },
  { name: 'unsigned', jwt: unsigned, expect: [0, 0] },
];

// ── 4. Той самий гейт, що в конвеєрі ────────────────────────────────────────
// spawn, а не spawnSync: гейт ходить у сервер ключів цього ж процесу, і
// заблокований event loop не відповів би йому ніколи.
function gate(tokenFile) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [path.join(ROOT, 'scripts/oidc-gate.mjs'), '--token-file', tokenFile, '--policy', POLICY, '--discovery-url', discoveryUrl],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    let stdout = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.on('close', (code) => resolve({ code, stdout }));
  });
}

let mismatched = 0;
for (const c of cases) {
  const file = path.join(work, `${c.name}.jwt`);
  writeFileSync(file, c.jwt, { mode: 0o600 });
  const { code, stdout } = await gate(file);
  const kv = Object.fromEntries(stdout.trim().split('\n').map((line) => line.split(/=(.*)/s).slice(0, 2)));
  const got = [Number(kv['sig-verified'] ?? -1), Number(kv['policy-allow'] ?? -1)];
  const match = got[0] === c.expect[0] && got[1] === c.expect[1];
  if (!match) mismatched++;

  console.log(`case=${c.name}`);
  console.log(`sig-verified=${got[0]}`);
  console.log(`policy-allow=${got[1]}`);
  if (kv['oidc-sub']) console.log(`sub=${kv['oidc-sub']}`);
  if (kv.reason) console.log(`reason=${kv.reason}`);
  console.log(`gate-exit=${code}`);
  console.log(`expected=${c.expect.join(' ')} match=${match ? 'yes' : 'NO'}`);
  console.log('');
}

server.close();
console.log(`cases=${cases.length}`);
console.log(`mismatched=${mismatched}`);
process.exitCode = mismatched === 0 ? 0 : 1;
