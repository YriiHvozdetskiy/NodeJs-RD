import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * #24: таблиця refresh-токенів — entity RefreshToken (src/entities/refresh-token.entity.ts).
 *
 * Згенерована частина — з entity; руками дописано лише GRANT: генератор про
 * ролі не знає, а застосунок ходить app_user. Без цього блоку перший логін —
 * `permission denied for table refresh_tokens` (демо, що ходять адміном, цього
 * не побачили б).
 *
 * Індекси:
 *   • UNIQUE (token_hash) — і обмеження, і індекс під єдиний пошук рефрешу
 *     «рядок за хешем предʼявленого токена»;
 *   • UNIQUE (parent_id) — у токена щонайбільше один наступник;
 *   • idx_refresh_tokens_family — відкликання сімʼї одним UPDATE … WHERE family_id.
 */
export class RefreshTokens1793645328525 implements MigrationInterface {
    name = 'RefreshTokens1793645328525'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "refresh_tokens" ("id" bigint GENERATED ALWAYS AS IDENTITY NOT NULL, "user_id" bigint NOT NULL, "family_id" uuid NOT NULL, "parent_id" bigint, "token_hash" text NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL, "used_at" TIMESTAMP WITH TIME ZONE, "revoked_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "refresh_tokens_parent_id_key" UNIQUE ("parent_id"), CONSTRAINT "refresh_tokens_token_hash_key" UNIQUE ("token_hash"), CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "idx_refresh_tokens_family" ON "refresh_tokens" ("family_id") `);
        await queryRunner.query(`ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "refresh_tokens"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);

        // ── вручну: права застосунку (та сама умова, що в InitSchema) ─────────
        await queryRunner.query(`
            DO $$
            BEGIN
                IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
                    GRANT SELECT, INSERT, UPDATE, DELETE ON refresh_tokens TO app_user;
                    GRANT USAGE, SELECT ON SEQUENCE refresh_tokens_id_seq TO app_user;
                END IF;
            END
            $$`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Права зникають разом із таблицею, окремий REVOKE не потрібен.
        await queryRunner.query(`ALTER TABLE "refresh_tokens" DROP CONSTRAINT "refresh_tokens_parent_id_fkey"`);
        await queryRunner.query(`ALTER TABLE "refresh_tokens" DROP CONSTRAINT "refresh_tokens_user_id_fkey"`);
        await queryRunner.query(`DROP INDEX "public"."idx_refresh_tokens_family"`);
        await queryRunner.query(`DROP TABLE "refresh_tokens"`);
    }

}
