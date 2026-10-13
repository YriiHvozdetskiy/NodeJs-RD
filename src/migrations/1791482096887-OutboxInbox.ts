import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * #22: доставка order.placed без dual write — три таблиці.
 *
 * Згенеровано `migration:generate` з entities (OutboxEvent, ProcessedMessage,
 * IdempotencyKey) і дописано руками лише GRANT — генератор про ролі не знає:
 *   • outbox — подія пишеться в транзакції checkout разом із замовленням,
 *     relay виносить її в брокер через FOR UPDATE SKIP LOCKED. Частковий
 *     індекс WHERE published_at IS NULL — рівно під запит relay;
 *   • processed_messages — inbox споживача: позначка «оброблено» комітиться
 *     в одній транзакції з ефектом;
 *   • idempotency_keys — Idempotency-Key з API-краю, у транзакції замовлення.
 *
 * Жодних даних не переносить: наявні замовлення подій у outbox не отримують.
 * Їхні order.placed (#19) уже опубліковані після COMMIT, і повторна публікація
 * дала б споживачу лише дублі.
 */
export class OutboxInbox1791482096887 implements MigrationInterface {
    name = 'OutboxInbox1791482096887'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "idempotency_keys" ("key" text NOT NULL, "fingerprint" text NOT NULL, "order_id" bigint NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("key"))`);
        await queryRunner.query(`CREATE TABLE "outbox" ("id" uuid NOT NULL, "aggregate_type" text NOT NULL, "aggregate_id" text NOT NULL, "type" text NOT NULL, "payload" jsonb NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "published_at" TIMESTAMP WITH TIME ZONE, "attempts" integer NOT NULL DEFAULT '0', "last_error" text, CONSTRAINT "outbox_attempts_check" CHECK (attempts >= 0), CONSTRAINT "outbox_pkey" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "outbox_unpublished" ON "outbox" ("created_at", "id") WHERE published_at IS NULL`);
        await queryRunner.query(`CREATE TABLE "processed_messages" ("message_id" uuid NOT NULL, "consumer" text NOT NULL, "processed_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "processed_messages_pkey" PRIMARY KEY ("message_id", "consumer"))`);
        await queryRunner.query(`ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);

        // ── вручну: права застосунку (та сама умова, що в InitSchema) ─────────
        // Застосунок пише outbox і ключі в checkout, а вбудований relay
        // позначає винесене — тому UPDATE. Послідовностей немає: ключі — uuid і text.
        await queryRunner.query(`
            DO $$
            BEGIN
                IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
                    GRANT SELECT, INSERT, UPDATE, DELETE ON outbox, processed_messages, idempotency_keys TO app_user;
                END IF;
            END
            $$`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Права зникають разом із таблицями, окремий REVOKE не потрібен.
        await queryRunner.query(`ALTER TABLE "idempotency_keys" DROP CONSTRAINT "idempotency_keys_order_id_fkey"`);
        await queryRunner.query(`DROP TABLE "processed_messages"`);
        await queryRunner.query(`DROP INDEX "public"."outbox_unpublished"`);
        await queryRunner.query(`DROP TABLE "outbox"`);
        await queryRunner.query(`DROP TABLE "idempotency_keys"`);
    }

}
