import type { Order, OrderItem, Payment, PointsEntry, Product, Promotion, User } from './entities';

/**
 * Детерміновані дані сіду. Id зафіксовані явно: саме вони роблять повторний
 * запуск безпечним (ON CONFLICT DO NOTHING по PK) і дають однакові числа в
 * демо N+1 та у звіті на будь-якій машині.
 *
 * Суми замовлень не вписані руками, а рахуються з позицій (buildOrders нижче):
 * CHECK total_cents = subtotal_cents - discount_cents перевіряє база, і сід
 * з арифметичною помилкою просто не вставиться.
 *
 * Кожен рядок типізований як Pick з усіма колонками, які сід заповнює, а не
 * Partial: тоді поле, яке сід сам же й записав, далі читається без `!`.
 */

type UserRow = Pick<User, 'id' | 'email' | 'role' | 'passwordHash' | 'createdAt'>;
type ProductRow = Pick<
  Product,
  | 'id' | 'sellerId' | 'category' | 'title' | 'description' | 'priceCents' | 'currency'
  | 'stock' | 'ratingAvg' | 'ratingCount' | 'imageKeys' | 'createdAt'
>;
type PromotionRow = Pick<
  Promotion,
  | 'id' | 'kind' | 'productId' | 'code' | 'percentOff' | 'minQty' | 'region' | 'timezone'
  | 'startsLocal' | 'endsLocal' | 'startsAt' | 'endsAt' | 'createdAt'
>;
type OrderRow = Pick<
  Order,
  | 'id' | 'buyerId' | 'deviceId' | 'region' | 'status' | 'currency' | 'subtotalCents'
  | 'discountCents' | 'totalCents' | 'pointsSpent' | 'promoCodeId' | 'createdAt'
>;
type OrderItemRow = Pick<OrderItem, 'orderId' | 'productId' | 'qty' | 'unitPriceCents' | 'discountCents' | 'promotionId'>;
type PaymentRow = Pick<Payment, 'id' | 'orderId' | 'amountCents' | 'status' | 'providerRef' | 'createdAt'>;
type PointsEntryRow = Pick<
  PointsEntry,
  'id' | 'userId' | 'orderId' | 'kind' | 'amount' | 'status' | 'maturesAt' | 'createdAt'
>;

// Не справжній хеш і не пароль: заглушка, поки немає автентифікації (#24).
const SEED_PASSWORD_HASH = '$argon2id$v=19$seed$not-a-real-hash';

const userSeeds: Pick<User, 'id' | 'email' | 'role'>[] = [
  { id: '1', email: 'admin@marketplace.test', role: 'admin' },
  { id: '2', email: 'seller.sport@marketplace.test', role: 'seller' },
  { id: '3', email: 'seller.tech@marketplace.test', role: 'seller' },
  { id: '4', email: 'olena@marketplace.test', role: 'buyer' },
  { id: '5', email: 'taras@marketplace.test', role: 'buyer' },
  { id: '6', email: 'iryna@marketplace.test', role: 'buyer' },
  { id: '7', email: 'andrii@marketplace.test', role: 'buyer' },
  { id: '8', email: 'sofiia@marketplace.test', role: 'buyer' },
];

export const users: UserRow[] = userSeeds.map((u) => ({
  ...u,
  passwordHash: SEED_PASSWORD_HASH,
  createdAt: new Date('2026-08-01T09:00:00Z'),
}));

type ProductSeed = Pick<Product, 'id' | 'sellerId' | 'category' | 'title' | 'priceCents' | 'stock'> &
  Partial<Pick<Product, 'ratingAvg' | 'ratingCount'>>;

const productSeeds: ProductSeed[] = [
  { id: '1', sellerId: '2', category: 'shoes', title: 'Кросівки Nike Pegasus 41', priceCents: 499900, stock: 20, ratingAvg: '4.70', ratingCount: 31 },
  { id: '2', sellerId: '2', category: 'shoes', title: 'Кеди Converse Chuck 70', priceCents: 329900, stock: 35, ratingAvg: '4.40', ratingCount: 12 },
  { id: '3', sellerId: '2', category: 'clothing', title: 'Худі Carhartt WIP Chase', priceCents: 389900, stock: 15 },
  { id: '4', sellerId: '2', category: 'clothing', title: 'Футболка Uniqlo U Crew', priceCents: 59900, stock: 120, ratingAvg: '4.10', ratingCount: 58 },
  { id: '5', sellerId: '2', category: 'sports', title: 'Килимок для йоги Manduka PRO', priceCents: 219900, stock: 8 },
  { id: '6', sellerId: '3', category: 'electronics', title: 'Клавіатура Keychron K2', priceCents: 260000, stock: 25, ratingAvg: '4.60', ratingCount: 44 },
  { id: '7', sellerId: '3', category: 'electronics', title: 'Навушники Sony WH-1000XM5', priceCents: 1450000, stock: 10, ratingAvg: '4.80', ratingCount: 97 },
  { id: '8', sellerId: '3', category: 'electronics', title: 'Монітор Dell U2723QE', priceCents: 2150000, stock: 4 },
  { id: '9', sellerId: '3', category: 'home', title: "Кавоварка De'Longhi Dedica", priceCents: 899900, stock: 6, ratingAvg: '4.30', ratingCount: 19 },
  { id: '10', sellerId: '3', category: 'books', title: 'Чистий код — Роберт Мартін', priceCents: 69900, stock: 50, ratingAvg: '4.90', ratingCount: 203 },
];

export const products: ProductRow[] = productSeeds.map((p, i) => ({
  description: `${p.title}. Демо-товар сіду.`,
  ratingAvg: null,
  ratingCount: 0,
  currency: 'UAH',
  imageKeys: [`products/${p.id}/main.webp`],
  createdAt: new Date(Date.UTC(2026, 7, 1 + i, 9)),
  ...p,
}));

// Одна акція кожного типу. Київ у вересні — UTC+3, тож 00:00 місцевого
// 1 вересня — це 21:00 UTC 31 серпня: *_local і *_at — та сама мить.
const SEPTEMBER = {
  region: 'UA',
  timezone: 'Europe/Kyiv',
  startsLocal: new Date('2026-09-01T00:00:00'),
  endsLocal: new Date('2026-10-01T00:00:00'),
  startsAt: new Date('2026-08-31T21:00:00Z'),
  endsAt: new Date('2026-09-30T21:00:00Z'),
  createdAt: new Date('2026-08-25T09:00:00Z'),
};

// Поріг «від N штук» — окрема константа, а не читання з рядка акції: у рядку
// min_qty має тип number | null, а для quantity_tier він завжди заданий.
const TIER_MIN_QTY = 3;

const seasonal: PromotionRow = { id: '1', kind: 'seasonal', productId: '1', code: null, percentOff: '15.00', minQty: null, ...SEPTEMBER };
const tier: PromotionRow = { id: '2', kind: 'quantity_tier', productId: '4', code: null, percentOff: '10.00', minQty: TIER_MIN_QTY, ...SEPTEMBER };
const welcome: PromotionRow = { id: '3', kind: 'promo_code', productId: null, code: 'WELCOME10', percentOff: '10.00', minQty: null, ...SEPTEMBER };

export const promotions: PromotionRow[] = [seasonal, tier, welcome];

// Замовлення: хто, у якому статусі, що купив і чи ввів промокод.
interface OrderSpec {
  buyerId: string;
  status: Order['status'];
  promoCode?: boolean;
  lines: [productId: string, qty: number][];
}

const orderSpecs: OrderSpec[] = [
  { buyerId: '4', status: 'paid', lines: [['1', 1], ['6', 1]] },
  { buyerId: '4', status: 'pending', lines: [['10', 2]] },
  { buyerId: '5', status: 'paid', lines: [['4', 3], ['3', 1]] },
  { buyerId: '5', status: 'paid', promoCode: true, lines: [['7', 1]] },
  { buyerId: '6', status: 'cancelled', lines: [['8', 1]] },
  { buyerId: '6', status: 'paid', lines: [['2', 1], ['5', 1], ['10', 1]] },
  { buyerId: '7', status: 'paid', lines: [['9', 1], ['4', 1]] },
  { buyerId: '7', status: 'pending', lines: [['1', 2], ['3', 1]] },
  { buyerId: '8', status: 'paid', lines: [['6', 1], ['7', 1]] },
  { buyerId: '8', status: 'pending', lines: [['5', 1], ['2', 1]] },
];

/** Знижка у копійках — завжди вниз до цілої копійки, щоб не подарувати зайве. */
const percentOf = (amountCents: number, percent: string) => Math.floor((amountCents * Number(percent)) / 100);

/** Одруківка в id товару в orderSpecs — помилка сіду, а не тихий NaN у сумах. */
function priceOf(productId: string): number {
  const product = products.find((p) => p.id === productId);
  if (!product) throw new Error(`seed: у orderSpecs посилання на неіснуючий товар ${productId}`);
  return product.priceCents;
}

/** Акція на позицію: сезонна — на свій товар, «від N штук» — від порогу. */
function promotionFor(productId: string, qty: number): PromotionRow | null {
  if (productId === seasonal.productId) return seasonal;
  if (productId === tier.productId && qty >= TIER_MIN_QTY) return tier;
  return null;
}

function buildOrders(): { orders: OrderRow[]; items: OrderItemRow[] } {
  const orders: OrderRow[] = [];
  const items: OrderItemRow[] = [];

  orderSpecs.forEach((spec, i) => {
    const orderId = String(i + 1);
    let subtotal = 0;
    let itemDiscounts = 0;

    for (const [productId, qty] of spec.lines) {
      const unit = priceOf(productId);
      const promo = promotionFor(productId, qty);
      const discount = promo ? percentOf(unit * qty, promo.percentOff) : 0;

      subtotal += unit * qty;
      itemDiscounts += discount;
      items.push({ orderId, productId, qty, unitPriceCents: unit, discountCents: discount, promotionId: promo?.id ?? null });
    }

    // Промокод діє на суму, що лишилась після знижок на позиції.
    const codeDiscount = spec.promoCode ? percentOf(subtotal - itemDiscounts, welcome.percentOff) : 0;
    const discount = itemDiscounts + codeDiscount;

    orders.push({
      id: orderId,
      buyerId: spec.buyerId,
      deviceId: `device-${spec.buyerId}`,
      region: 'UA',
      status: spec.status,
      currency: 'UAH',
      subtotalCents: subtotal,
      discountCents: discount,
      totalCents: subtotal - discount,
      pointsSpent: 0,
      promoCodeId: spec.promoCode ? welcome.id : null,
      createdAt: new Date(Date.UTC(2026, 8, 1 + i, 10)),
    });
  });

  return { orders, items };
}

export const { orders, items: orderItems } = buildOrders();

const paidOrders = orders.filter((o) => o.status === 'paid');

export const payments: PaymentRow[] = paidOrders.map((o, i) => ({
  id: String(i + 1),
  orderId: o.id,
  amountCents: o.totalCents,
  status: 'succeeded',
  providerRef: `psp_seed_${String(i + 1).padStart(4, '0')}`,
  createdAt: new Date(o.createdAt.getTime() + 5 * 60_000),
}));

// Той самий курс, що в db/seed.sql з #12: 1 бал за кожні повні 100 грн.
// Бали дозрівають за 14 днів; статус рахується від фіксованої дати, а не від
// now(), інакше сід давав би різні дані залежно від дня запуску.
const POINTS_PER_CENTS = 100_00;
const MATURITY_MS = 14 * 24 * 3600_000;
const AS_OF = new Date('2026-09-20T00:00:00Z');

export const pointsEntries: PointsEntryRow[] = paidOrders
  .filter((o) => o.totalCents >= POINTS_PER_CENTS)
  .map((o, i) => {
    const maturesAt = new Date(o.createdAt.getTime() + MATURITY_MS);
    return {
      id: String(i + 1),
      userId: o.buyerId,
      orderId: o.id,
      kind: 'earned',
      amount: Math.floor(o.totalCents / POINTS_PER_CENTS),
      status: maturesAt <= AS_OF ? 'available' : 'pending',
      maturesAt,
      createdAt: new Date(o.createdAt.getTime() + 10 * 60_000),
    };
  });
