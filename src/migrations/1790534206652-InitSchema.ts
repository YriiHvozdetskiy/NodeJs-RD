import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Початкова схема: сім таблиць із ДЗ #12, гроші — integer у копійках.
 *
 * Згенеровано `migration:generate` проти порожньої бази й дописано руками
 * там, де генератор безсилий (блоки «вручну» нижче):
 *   • idx_users_email_lower — expression index по lower(email), а `@Index`
 *     уміє лише колонки;
 *   • idx_products_search_vector — GIN, а `@Index` не має USING.
 *   Обидва оголошені в entity з `synchronize: false`: TypeORM знає, що вони
 *   існують, і наступний migration:generate не спробує їх знести.
 *   • GRANT для app_user — генератор не знає про ролі. Схему створює
 *     власник (admin), а застосунок ходить app_user; без GRANT його перший
 *     SELECT упав би з permission denied. Обгорнуто в перевірку існування
 *     ролі: на базі без app_user (testcontainers на #16) міграція не падає.
 *
 * INSERT у typeorm_metadata — не сміття: так TypeORM запам'ятовує вираз
 * генерованої колонки search_vector, щоб порівнювати його на наступних
 * generate. Таблицю typeorm_metadata CLI створює сам перед запуском міграцій.
 */
export class InitSchema1790534206652 implements MigrationInterface {
    name = 'InitSchema1790534206652'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "order_items" ("order_id" bigint NOT NULL, "product_id" bigint NOT NULL, "qty" integer NOT NULL, "unit_price_cents" integer NOT NULL, "discount_cents" integer NOT NULL DEFAULT '0', "promotion_id" bigint, CONSTRAINT "order_items_promotion_consistency_check" CHECK ((promotion_id IS NULL) = (discount_cents = 0)), CONSTRAINT "order_items_discount_cents_check" CHECK (discount_cents >= 0 AND discount_cents <= unit_price_cents * qty), CONSTRAINT "order_items_unit_price_cents_check" CHECK (unit_price_cents >= 0), CONSTRAINT "order_items_qty_check" CHECK (qty > 0), CONSTRAINT "order_items_pkey" PRIMARY KEY ("order_id", "product_id"))`);
        await queryRunner.query(`CREATE TABLE "orders" ("id" bigint GENERATED ALWAYS AS IDENTITY NOT NULL, "buyer_id" bigint NOT NULL, "device_id" text, "region" text NOT NULL, "status" text NOT NULL DEFAULT 'pending', "currency" text NOT NULL DEFAULT 'UAH', "subtotal_cents" integer NOT NULL, "discount_cents" integer NOT NULL DEFAULT '0', "total_cents" integer NOT NULL, "points_spent" integer NOT NULL DEFAULT '0', "promo_code_id" bigint, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "orders_total_consistency_check" CHECK (total_cents = subtotal_cents - discount_cents), CONSTRAINT "orders_points_spent_check" CHECK (points_spent >= 0), CONSTRAINT "orders_total_cents_check" CHECK (total_cents >= 0), CONSTRAINT "orders_discount_cents_check" CHECK (discount_cents >= 0), CONSTRAINT "orders_subtotal_cents_check" CHECK (subtotal_cents >= 0), CONSTRAINT "orders_currency_check" CHECK (currency ~ '^[A-Z]{3}$'), CONSTRAINT "orders_status_check" CHECK (status IN ('pending', 'paid', 'cancelled')), CONSTRAINT "orders_region_check" CHECK (region ~ '^[A-Z]{2}$'), CONSTRAINT "orders_pkey" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "idx_orders_pending_created" ON "orders" ("created_at") WHERE status = 'pending'`);
        await queryRunner.query(`CREATE INDEX "idx_orders_buyer_created" ON "orders" ("buyer_id", "created_at", "id") `);
        await queryRunner.query(`CREATE TABLE "payments" ("id" bigint GENERATED ALWAYS AS IDENTITY NOT NULL, "order_id" bigint NOT NULL, "amount_cents" integer NOT NULL, "status" text NOT NULL DEFAULT 'pending', "provider_ref" text, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "REL_b2f7b823a21562eeca20e72b00" UNIQUE ("order_id"), CONSTRAINT "payments_status_check" CHECK (status IN ('pending', 'succeeded', 'failed')), CONSTRAINT "payments_amount_cents_check" CHECK (amount_cents > 0), CONSTRAINT "payments_pkey" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "points_entries" ("id" bigint GENERATED ALWAYS AS IDENTITY NOT NULL, "user_id" bigint NOT NULL, "order_id" bigint, "kind" text NOT NULL, "amount" integer NOT NULL, "status" text NOT NULL, "matures_at" TIMESTAMP WITH TIME ZONE, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "points_entries_spent_status_check" CHECK (kind = 'earned' OR status = 'spent'), CONSTRAINT "points_entries_matures_by_kind_check" CHECK ((kind = 'earned') = (matures_at IS NOT NULL)), CONSTRAINT "points_entries_status_check" CHECK (status IN ('pending', 'available', 'spent')), CONSTRAINT "points_entries_amount_check" CHECK (amount > 0), CONSTRAINT "points_entries_kind_check" CHECK (kind IN ('earned', 'spent')), CONSTRAINT "points_entries_pkey" PRIMARY KEY ("id"))`);
        await queryRunner.query(`INSERT INTO "typeorm_metadata"("database", "schema", "table", "type", "name", "value") VALUES ($1, $2, $3, $4, $5, $6)`, ["marketplace","public","products","GENERATED_COLUMN","search_vector","to_tsvector('simple', title || ' ' || description)"]);
        await queryRunner.query(`CREATE TABLE "products" ("id" bigint GENERATED ALWAYS AS IDENTITY NOT NULL, "seller_id" bigint NOT NULL, "category" text NOT NULL, "title" text NOT NULL, "description" text NOT NULL DEFAULT '', "price_cents" integer NOT NULL, "currency" text NOT NULL DEFAULT 'UAH', "stock" integer NOT NULL DEFAULT '0', "rating_avg" numeric(3,2), "rating_count" integer NOT NULL DEFAULT '0', "image_keys" text array NOT NULL DEFAULT '{}', "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "search_vector" tsvector GENERATED ALWAYS AS (to_tsvector('simple', title || ' ' || description)) STORED, CONSTRAINT "products_rating_consistency_check" CHECK ((rating_count = 0) = (rating_avg IS NULL)), CONSTRAINT "products_rating_count_check" CHECK (rating_count >= 0), CONSTRAINT "products_rating_avg_check" CHECK (rating_avg BETWEEN 1 AND 5), CONSTRAINT "products_stock_check" CHECK (stock >= 0), CONSTRAINT "products_currency_check" CHECK (currency ~ '^[A-Z]{3}$'), CONSTRAINT "products_price_cents_check" CHECK (price_cents >= 0), CONSTRAINT "products_title_check" CHECK (length(title) BETWEEN 1 AND 200), CONSTRAINT "products_category_check" CHECK (category IN ('shoes', 'clothing', 'electronics', 'home', 'sports', 'books')), CONSTRAINT "products_pkey" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "promotions" ("id" bigint GENERATED ALWAYS AS IDENTITY NOT NULL, "product_id" bigint, "kind" text NOT NULL, "code" text, "percent_off" numeric(5,2) NOT NULL, "min_qty" integer, "region" text NOT NULL, "timezone" text NOT NULL, "starts_local" TIMESTAMP NOT NULL, "ends_local" TIMESTAMP NOT NULL, "starts_at" TIMESTAMP WITH TIME ZONE NOT NULL, "ends_at" TIMESTAMP WITH TIME ZONE NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "promotions_code_key" UNIQUE ("code"), CONSTRAINT "promotions_min_qty_by_kind_check" CHECK ((kind = 'quantity_tier') = (min_qty IS NOT NULL)), CONSTRAINT "promotions_code_by_kind_check" CHECK ((kind = 'promo_code') = (code IS NOT NULL)), CONSTRAINT "promotions_product_by_kind_check" CHECK ((kind = 'promo_code') = (product_id IS NULL)), CONSTRAINT "promotions_local_period_check" CHECK (ends_local > starts_local), CONSTRAINT "promotions_period_check" CHECK (ends_at > starts_at), CONSTRAINT "promotions_region_check" CHECK (region ~ '^[A-Z]{2}$'), CONSTRAINT "promotions_min_qty_check" CHECK (min_qty > 1), CONSTRAINT "promotions_percent_off_check" CHECK (percent_off > 0 AND percent_off <= 100), CONSTRAINT "promotions_kind_check" CHECK (kind IN ('seasonal', 'quantity_tier', 'promo_code')), CONSTRAINT "promotions_pkey" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "users" ("id" bigint GENERATED ALWAYS AS IDENTITY NOT NULL, "email" text NOT NULL, "password_hash" text NOT NULL, "role" text NOT NULL DEFAULT 'buyer', "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "users_email_key" UNIQUE ("email"), CONSTRAINT "users_role_check" CHECK (role IN ('buyer', 'seller', 'admin')), CONSTRAINT "users_pkey" PRIMARY KEY ("id"))`);
        await queryRunner.query(`ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "order_items" ADD CONSTRAINT "order_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "order_items" ADD CONSTRAINT "order_items_promotion_id_fkey" FOREIGN KEY ("promotion_id") REFERENCES "promotions"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "orders" ADD CONSTRAINT "orders_buyer_id_fkey" FOREIGN KEY ("buyer_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "orders" ADD CONSTRAINT "orders_promo_code_id_fkey" FOREIGN KEY ("promo_code_id") REFERENCES "promotions"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "payments" ADD CONSTRAINT "payments_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "points_entries" ADD CONSTRAINT "points_entries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "points_entries" ADD CONSTRAINT "points_entries_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "products" ADD CONSTRAINT "products_seller_id_fkey" FOREIGN KEY ("seller_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "promotions" ADD CONSTRAINT "promotions_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);

        // ── вручну: індекси, які @Index не виражає ─────────────────────────
        await queryRunner.query(`CREATE INDEX "idx_users_email_lower" ON "users" ((lower(email)))`);
        await queryRunner.query(`CREATE INDEX "idx_products_search_vector" ON "products" USING GIN ("search_vector")`);

        // ── вручну: права застосунку ──────────────────────────────────────
        // Перелік таблиць явний, а не ALL TABLES: інакше app_user отримав би
        // DELETE і на службові migrations / typeorm_metadata.
        // Sequences окремо: GENERATED … AS IDENTITY бере значення з них.
        await queryRunner.query(`
            DO $$
            BEGIN
                IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
                    GRANT SELECT, INSERT, UPDATE, DELETE
                        ON users, products, promotions, orders, order_items, payments, points_entries
                        TO app_user;
                    GRANT USAGE, SELECT
                        ON SEQUENCE users_id_seq, products_id_seq, promotions_id_seq, orders_id_seq,
                                    payments_id_seq, points_entries_id_seq
                        TO app_user;
                END IF;
            END
            $$`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Права зникають разом із таблицями, окремий REVOKE не потрібен.
        // ── вручну: індекси, створені в up() руками ─────────────────────────
        await queryRunner.query(`DROP INDEX "public"."idx_products_search_vector"`);
        await queryRunner.query(`DROP INDEX "public"."idx_users_email_lower"`);
        await queryRunner.query(`ALTER TABLE "promotions" DROP CONSTRAINT "promotions_product_id_fkey"`);
        await queryRunner.query(`ALTER TABLE "products" DROP CONSTRAINT "products_seller_id_fkey"`);
        await queryRunner.query(`ALTER TABLE "points_entries" DROP CONSTRAINT "points_entries_order_id_fkey"`);
        await queryRunner.query(`ALTER TABLE "points_entries" DROP CONSTRAINT "points_entries_user_id_fkey"`);
        await queryRunner.query(`ALTER TABLE "payments" DROP CONSTRAINT "payments_order_id_fkey"`);
        await queryRunner.query(`ALTER TABLE "orders" DROP CONSTRAINT "orders_promo_code_id_fkey"`);
        await queryRunner.query(`ALTER TABLE "orders" DROP CONSTRAINT "orders_buyer_id_fkey"`);
        await queryRunner.query(`ALTER TABLE "order_items" DROP CONSTRAINT "order_items_promotion_id_fkey"`);
        await queryRunner.query(`ALTER TABLE "order_items" DROP CONSTRAINT "order_items_product_id_fkey"`);
        await queryRunner.query(`ALTER TABLE "order_items" DROP CONSTRAINT "order_items_order_id_fkey"`);
        await queryRunner.query(`DROP TABLE "users"`);
        await queryRunner.query(`DROP TABLE "promotions"`);
        await queryRunner.query(`DROP TABLE "products"`);
        await queryRunner.query(`DELETE FROM "typeorm_metadata" WHERE "type" = $1 AND "name" = $2 AND "database" = $3 AND "schema" = $4 AND "table" = $5`, ["GENERATED_COLUMN","search_vector","marketplace","public","products"]);
        await queryRunner.query(`DROP TABLE "points_entries"`);
        await queryRunner.query(`DROP TABLE "payments"`);
        await queryRunner.query(`DROP INDEX "public"."idx_orders_buyer_created"`);
        await queryRunner.query(`DROP INDEX "public"."idx_orders_pending_created"`);
        await queryRunner.query(`DROP TABLE "orders"`);
        await queryRunner.query(`DROP TABLE "order_items"`);
    }

}
