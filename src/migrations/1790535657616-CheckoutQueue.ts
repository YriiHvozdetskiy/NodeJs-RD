import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * #14: черга задач і два індекси під транзакційний checkout.
 *
 * Згенеровано `migration:generate` з entities (Job, Order, PointsEntry) і
 * дописано руками лише GRANT — генератор про ролі не знає:
 *   • jobs — таблиця черги; checkout кладе туди задачу на чек у тій самій
 *     транзакції, що й замовлення, воркери розбирають через SKIP LOCKED;
 *   • one_code_per_user — «промокод раз на користувача», відкладений з #12
 *     до транзакції, яка на нього спирається. Сід роздає коди через
 *     DISTINCT ON (buyer_id, promo_code_id), тож індекс стає без чистки;
 *   • idx_points_entries_user — баланс балів = SUM по журналу користувача,
 *     і рахується він під локом: без індексу лок тримався б на час seq scan.
 */
export class CheckoutQueue1790535657616 implements MigrationInterface {
    name = 'CheckoutQueue1790535657616'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "jobs" ("id" bigint GENERATED ALWAYS AS IDENTITY NOT NULL, "kind" text NOT NULL, "payload" jsonb NOT NULL DEFAULT '{}', "status" text NOT NULL DEFAULT 'pending', "attempts" integer NOT NULL DEFAULT '0', "max_attempts" integer NOT NULL DEFAULT '5', "processed" integer NOT NULL DEFAULT '0', "processed_by" text, "result" jsonb, "last_error" text, "run_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "done_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "jobs_done_at_by_status_check" CHECK ((status = 'done') = (done_at IS NOT NULL)), CONSTRAINT "jobs_processed_check" CHECK (processed >= 0), CONSTRAINT "jobs_max_attempts_check" CHECK (max_attempts > 0), CONSTRAINT "jobs_attempts_check" CHECK (attempts >= 0), CONSTRAINT "jobs_status_check" CHECK (status IN ('pending', 'done', 'failed')), CONSTRAINT "jobs_kind_check" CHECK (kind IN ('order_receipt', 'demo')), CONSTRAINT "jobs_pkey" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "idx_jobs_pending" ON "jobs" ("run_at", "id") WHERE status = 'pending'`);
        await queryRunner.query(`CREATE UNIQUE INDEX "one_code_per_user" ON "orders" ("buyer_id", "promo_code_id") WHERE promo_code_id IS NOT NULL`);
        await queryRunner.query(`CREATE INDEX "idx_points_entries_user" ON "points_entries" ("user_id") `);

        // ── вручну: права застосунку (та сама умова, що в InitSchema) ─────────
        await queryRunner.query(`
            DO $$
            BEGIN
                IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
                    GRANT SELECT, INSERT, UPDATE, DELETE ON jobs TO app_user;
                    GRANT USAGE, SELECT ON SEQUENCE jobs_id_seq TO app_user;
                END IF;
            END
            $$`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Права зникають разом із таблицею, окремий REVOKE не потрібен.
        await queryRunner.query(`DROP INDEX "public"."idx_points_entries_user"`);
        await queryRunner.query(`DROP INDEX "public"."one_code_per_user"`);
        await queryRunner.query(`DROP INDEX "public"."idx_jobs_pending"`);
        await queryRunner.query(`DROP TABLE "jobs"`);
    }

}
