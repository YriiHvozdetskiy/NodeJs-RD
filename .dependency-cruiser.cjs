// dependency-cruiser (#32) — сходинка «архітектура» конвеєра.
//
//   npm run arch        # = depcruise --config .dependency-cruiser.cjs src
//
// Робить фразу README «модулі не лізуть один в одного» перевірюваною: кожне
// правило нижче — одне речення з README (розділ CI/CD → Архітектура), і
// порушення будь-якого валить сходинку з кодом 1 і називає файл та імпорт.
//
// Шляхи з `(^|/)` на початку: правило має спрацювати і на src/, і на копії
// дерева в тимчасовій теці, де demo:gates підкладає зумисне заборонений імпорт.
const DOMAINS = 'catalog|orders|checkout|users|loyalty';

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      // Каталог, користувачі й бали — листові домени: про інші домени вони не
      // знають. Каталог, що імпортує замовлення, означає цикл «товар знає про
      // своїх покупців», і першою його жертвою стає кеш картки товару (#23).
      // $2 — модуль джерела з `from.path`: імпорт усередині свого модуля дозволений.
      name: 'leaf-domain-stays-leaf',
      severity: 'error',
      from: { path: '(^|/)src/(catalog|users|loyalty)/' },
      to: { path: `(^|/)src/(${DOMAINS})/`, pathNot: '(^|/)src/$2/' },
    },
    {
      // Замовлення ходять лише в checkout (оформлення в одній транзакції) і в
      // catalog (картка товару). Користувачі й бали доїжджають подією через
      // outbox (#22), а не прямим викликом: інакше збій нарахування балів
      // відкочував би оформлення.
      name: 'orders-only-via-checkout-and-catalog',
      severity: 'error',
      from: { path: '(^|/)src/orders/' },
      to: { path: '(^|/)src/(users|loyalty)/' },
    },
    {
      // Інфраструктура не знає про домени: пул БД, конфіг, спільні фільтри й
      // entities мають працювати для будь-якого модуля. Імпорт навпаки —
      // перший крок до циклу, який Nest виявить лише в рантаймі.
      name: 'infra-knows-no-domain',
      severity: 'error',
      from: { path: '(^|/)src/(db|config|common|entities)/' },
      to: { path: `(^|/)src/(${DOMAINS}|auth|messaging|outbox)/` },
    },
    {
      // Демо-код (src/demo-*.ts, */demo-kit.ts) піднімає контейнери, ходить у
      // мережу й друкує секретні маркери. Застосунок його не імпортує ніколи —
      // інакше все це поїхало б в образ як робочий код.
      name: 'app-never-imports-demo',
      severity: 'error',
      from: { path: '(^|/)src/', pathNot: '/demo-[a-z0-9-]+\\.ts$' },
      to: { path: '/demo-[a-z0-9-]+\\.ts$' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsConfig: { fileName: 'tsconfig.json' },
    // `import type` теж залежність: тип із чужого домену — той самий звʼязок.
    tsPreCompilationDeps: true,
  },
};
