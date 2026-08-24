// Та сама перевірка, що в acceptance criteria — файлом, щоб не копіювати
// багаторядковий node -e у термінал. Читає spec.json з `redocly bundle`.
const s = require('../spec.json');
const M = ['get', 'post', 'put', 'patch', 'delete'];

const ops = Object.entries(s.paths).flatMap(([p, v]) =>
  Object.keys(v).filter((m) => M.includes(m)).map((m) => [p, m]),
);
const idem = ops
  .flatMap(([p, m]) => s.paths[p][m].parameters ?? [])
  .find((x) => x.in === 'header' && /idempotency-key/i.test(x.name));

console.log('операцій:', ops.length, '· ресурсів:', new Set(Object.keys(s.paths).map((p) => p.split('/')[1])).size);
console.log('Idempotency-Key: required =', idem?.required, '· опис, символів =', (idem?.description ?? '').trim().length);
