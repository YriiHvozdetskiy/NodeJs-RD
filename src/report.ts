import dataSource from './data-source';
import { OrderItem } from './entities';

/**
 * Звіт «виторг по категоріях» за оплаченими замовленнями.
 *
 * find() такого не вміє принципово: він повертає граф entities, а тут
 * результат — рядки звіту, яких немає в жодній таблиці (SUM, COUNT DISTINCT,
 * GROUP BY по колонці з іншої таблиці). Тому createQueryBuilder().getRawMany().
 *
 * Виторг рахується з позицій, а не з orders.total_cents: промокод діє на все
 * замовлення, і розкласти його по категоріях без домовленості про пропорцію
 * не можна. Тому тут «виторг до промокоду» = ціна × кількість − знижка позиції.
 *
 * Агрегати Postgres віддає рядками (SUM від integer — це bigint, COUNT — теж
 * bigint), і драйвер не конвертує їх у number, щоб не втратити точність за
 * межею 2^53. Конвертуємо самі — через BigInt, для копійок це безпечно.
 */
interface RevenueRow {
  category: string;
  orders: string;
  units: string;
  revenue_cents: string;
}

const uah = (cents: bigint) =>
  `${(cents / 100n).toLocaleString('uk-UA')}.${String(cents % 100n).padStart(2, '0')} UAH`;

async function main() {
  await dataSource.initialize();
  try {
    const rows = await dataSource
      .getRepository(OrderItem)
      .createQueryBuilder('item')
      .innerJoin('item.order', 'o')
      .innerJoin('item.product', 'p')
      .select('p.category', 'category')
      .addSelect('COUNT(DISTINCT o.id)', 'orders')
      .addSelect('SUM(item.qty)', 'units')
      .addSelect('SUM(item.unitPriceCents * item.qty - item.discountCents)', 'revenue_cents')
      .where('o.status = :status', { status: 'paid' })
      .groupBy('p.category')
      .orderBy('revenue_cents', 'DESC')
      .getRawMany<RevenueRow>();

    console.log('Виторг по категоріях (оплачені замовлення, до промокоду):');
    console.table(
      rows.map((r) => ({
        категорія: r.category,
        замовлень: Number(r.orders),
        одиниць: Number(r.units),
        виторг: uah(BigInt(r.revenue_cents)),
      })),
    );
    const total = rows.reduce((sum, r) => sum + BigInt(r.revenue_cents), 0n);
    console.log(`Разом: ${uah(total)}`);
  } finally {
    await dataSource.destroy();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
