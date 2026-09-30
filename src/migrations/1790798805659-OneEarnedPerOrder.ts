import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * #19: одне нарахування балів на замовлення — ключ ідемпотентності споживача
 * order.placed (src/loyalty/points-accrual.ts).
 *
 * Наявні дані правило вже виконують: сід нараховує `earned` один раз на
 * оплачене замовлення, а стартові бонуси demo:race (#14) — без order_id, і
 * NULL в унікальному індексі не конфліктує. Якщо на якійсь базі дубль уже є,
 * CREATE UNIQUE INDEX упаде з назвою пари — і це правильно: такий дубль —
 * подвоєні бали, які треба розібрати руками, а не сховати.
 */
export class OneEarnedPerOrder1790798805659 implements MigrationInterface {
    name = 'OneEarnedPerOrder1790798805659'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE UNIQUE INDEX "points_entries_one_earned_per_order" ON "points_entries" ("order_id") WHERE kind = 'earned'`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."points_entries_one_earned_per_order"`);
    }
}
