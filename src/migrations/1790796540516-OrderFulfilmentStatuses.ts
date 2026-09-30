import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * #18: стадії відвантаження в `orders.status` — packed, shipped, delivered.
 *
 * Написано руками повністю. `migration:generate` порівнює CHECK-и за іменем, а
 * не за виразом: на змінений `@Check('orders_status_check', …)` в Order він
 * відповідає «No changes in database schema were found». Тому ім'я те саме, а
 * вираз — рівно той, що в entity, символ у символ.
 *
 * Новий набір — надмножина старого: наявні рядки проходять перевірку без
 * жодної правки.
 *
 * `down` старий CHECK не поверне, поки в таблиці є замовлення в нових
 * статусах. Відвантажене замовлення вже оплачене, тому відкат зводить його до
 * `paid` — стадія відвантаження губиться, оплата ні.
 */
export class OrderFulfilmentStatuses1790796540516 implements MigrationInterface {
    name = 'OrderFulfilmentStatuses1790796540516'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "orders" DROP CONSTRAINT "orders_status_check"`);
        await queryRunner.query(`ALTER TABLE "orders" ADD CONSTRAINT "orders_status_check" CHECK (status IN ('pending', 'paid', 'packed', 'shipped', 'delivered', 'cancelled'))`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "orders" DROP CONSTRAINT "orders_status_check"`);
        // ── вручну: інакше ADD CONSTRAINT впаде на першому ж shipped ──────────
        await queryRunner.query(`UPDATE "orders" SET status = 'paid' WHERE status IN ('packed', 'shipped', 'delivered')`);
        await queryRunner.query(`ALTER TABLE "orders" ADD CONSTRAINT "orders_status_check" CHECK (status IN ('pending', 'paid', 'cancelled'))`);
    }
}
