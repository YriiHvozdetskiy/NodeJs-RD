import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * #26: таблиця файлів сховища — entity StoredFile (src/entities/stored-file.entity.ts).
 *
 * Згенерована частина — з entity; руками дописано лише GRANT, як у
 * RefreshTokens: генератор про ролі не знає, а застосунок ходить app_user.
 * Послідовності тут немає — `id` генерує сервер (UUID із ключа обʼєкта).
 *
 * Індекси:
 *   • UNIQUE (key) — один рядок на обʼєкт сховища;
 *   • UNIQUE (owner_id, idempotency_key) — подвійний intent з тим самим
 *     Idempotency-Key повертає наявний рядок, а не створює другий;
 *   • idx_files_owner_created — «мої файли» сторінками, без листингу бакета;
 *   • idx_files_pending_created — частковий: прибирання сиріт шукає лише
 *     pending старші за добу, і completed-рядки в індекс не потрапляють.
 */
export class Files1794236312369 implements MigrationInterface {
    name = 'Files1794236312369'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "files" ("id" uuid NOT NULL, "owner_id" bigint NOT NULL, "key" text NOT NULL, "content_type" text NOT NULL, "size" bigint NOT NULL, "status" text NOT NULL DEFAULT 'pending', "upload_id" text, "etag" text, "idempotency_key" text, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "completed_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "files_owner_idempotency_key" UNIQUE ("owner_id", "idempotency_key"), CONSTRAINT "files_key_key" UNIQUE ("key"), CONSTRAINT "files_completed_at_check" CHECK ((status = 'completed') = (completed_at IS NOT NULL)), CONSTRAINT "files_size_check" CHECK (size > 0), CONSTRAINT "files_status_check" CHECK (status IN ('pending', 'completed')), CONSTRAINT "files_pkey" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "idx_files_pending_created" ON "files" ("created_at") WHERE status = 'pending'`);
        await queryRunner.query(`CREATE INDEX "idx_files_owner_created" ON "files" ("owner_id", "created_at") `);
        await queryRunner.query(`ALTER TABLE "files" ADD CONSTRAINT "files_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);

        // ── вручну: права застосунку (та сама умова, що в InitSchema) ─────────
        await queryRunner.query(`
            DO $$
            BEGIN
                IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
                    GRANT SELECT, INSERT, UPDATE, DELETE ON files TO app_user;
                END IF;
            END
            $$`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Права зникають разом із таблицею, окремий REVOKE не потрібен.
        await queryRunner.query(`ALTER TABLE "files" DROP CONSTRAINT "files_owner_id_fkey"`);
        await queryRunner.query(`DROP INDEX "public"."idx_files_owner_created"`);
        await queryRunner.query(`DROP INDEX "public"."idx_files_pending_created"`);
        await queryRunner.query(`DROP TABLE "files"`);
    }

}
