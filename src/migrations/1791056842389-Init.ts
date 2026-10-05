import { MigrationInterface, QueryRunner } from "typeorm";

export class Init1791056842389 implements MigrationInterface {
    name = 'Init1791056842389'

    public async up(queryRunner: QueryRunner): Promise<void> {
        // --- hand-written: the generator emits the INSERT into typeorm_metadata
        // below but not the table itself. It creates the table for real as a side
        // effect while diffing, so any DB that ran migrate:generate already has
        // it and a fresh one doesn't — hence IF NOT EXISTS. Definition from
        // TypeORM's RdbmsSchemaBuilder.createTypeormMetadataTable.
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "typeorm_metadata" ("type" varchar NOT NULL, "database" varchar, "schema" varchar, "table" varchar, "name" varchar, "value" text)`);
        // --- generated statements follow ---
        await queryRunner.query(`CREATE TABLE "users" ("id" bigint GENERATED ALWAYS AS IDENTITY NOT NULL, "email" text NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "users_email_key" UNIQUE ("email"), CONSTRAINT "PK_a3ffb1c0c8416b9fc6f907b7433" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "orders" ("id" bigint GENERATED ALWAYS AS IDENTITY NOT NULL, "status" text NOT NULL DEFAULT 'new', "total" numeric(12,2) NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "user_id" bigint NOT NULL, CONSTRAINT "orders_total_check" CHECK (total >= 0), CONSTRAINT "orders_status_check" CHECK (status IN ('new', 'paid', 'shipped', 'cancelled')), CONSTRAINT "PK_710e2d4957aa5878dfe94e4ac2f" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "orders_new_created_idx" ON "orders"  ("created_at") WHERE status = 'new'`);
        await queryRunner.query(`CREATE INDEX "orders_user_created_idx" ON "orders"  ("user_id", "created_at") `);
        await queryRunner.query(`INSERT INTO "typeorm_metadata"("database", "schema", "table", "type", "name", "value") VALUES ($1, $2, $3, $4, $5, $6)`, ["shop","public","products","GENERATED_COLUMN","search_vector","to_tsvector('simple', name || ' ' || description)"]);
        await queryRunner.query(`CREATE TABLE "products" ("id" bigint GENERATED ALWAYS AS IDENTITY NOT NULL, "name" text NOT NULL, "description" text NOT NULL, "price" numeric(12,2) NOT NULL, "in_stock" boolean NOT NULL DEFAULT false, "deleted_at" TIMESTAMP WITH TIME ZONE, "search_vector" tsvector GENERATED ALWAYS AS (to_tsvector('simple', name || ' ' || description)) STORED, CONSTRAINT "products_price_check" CHECK (price >= 0), CONSTRAINT "PK_0806c755e0aca124e67c0cf6d7d" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "products_search_vector_idx" ON "products" USING gin ("search_vector") WHERE deleted_at IS NULL`);
        await queryRunner.query(`CREATE TABLE "order_items" ("order_id" bigint NOT NULL, "product_id" bigint NOT NULL, "quantity" integer NOT NULL, "unit_price" numeric(12,2) NOT NULL, "product_name" text NOT NULL, CONSTRAINT "order_items_unit_price_check" CHECK (unit_price >= 0), CONSTRAINT "order_items_quantity_check" CHECK (quantity > 0), CONSTRAINT "PK_6335813ef19bc35b8d866cc6565" PRIMARY KEY ("order_id", "product_id"))`);
        await queryRunner.query(`CREATE INDEX "order_items_product_id_idx" ON "order_items"  ("product_id") `);
        await queryRunner.query(`ALTER TABLE "orders" ADD CONSTRAINT "FK_a922b820eeef29ac1c6800e826a" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "order_items" ADD CONSTRAINT "FK_145532db85752b29c57d2b7b1f1" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "order_items" ADD CONSTRAINT "FK_9263386c35b6b242540f9493b00" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);

        // --- hand-written: objects TypeORM can't describe (from HW#12 indexes.sql) ---
        // q3: expression index, partial on live products.
        await queryRunner.query(`CREATE INDEX "products_lower_name_idx" ON "products" (lower(name)) WHERE deleted_at IS NULL`);
        // The planner ignores a partial index's expression statistics; this restores them.
        await queryRunner.query(`CREATE STATISTICS "products_lower_name_stat" ON (lower(name)) FROM "products"`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // --- hand-written, reversed ---
        await queryRunner.query(`DROP STATISTICS "public"."products_lower_name_stat"`);
        await queryRunner.query(`DROP INDEX "public"."products_lower_name_idx"`);
        // --- generated statements follow ---
        await queryRunner.query(`ALTER TABLE "order_items" DROP CONSTRAINT "FK_9263386c35b6b242540f9493b00"`);
        await queryRunner.query(`ALTER TABLE "order_items" DROP CONSTRAINT "FK_145532db85752b29c57d2b7b1f1"`);
        await queryRunner.query(`ALTER TABLE "orders" DROP CONSTRAINT "FK_a922b820eeef29ac1c6800e826a"`);
        await queryRunner.query(`DROP INDEX "public"."order_items_product_id_idx"`);
        await queryRunner.query(`DROP TABLE "order_items"`);
        await queryRunner.query(`DROP INDEX "public"."products_search_vector_idx"`);
        await queryRunner.query(`DROP TABLE "products"`);
        await queryRunner.query(`DELETE FROM "typeorm_metadata" WHERE "type" = $1 AND "name" = $2 AND "database" = $3 AND "schema" = $4 AND "table" = $5`, ["GENERATED_COLUMN","search_vector","shop","public","products"]);
        await queryRunner.query(`DROP INDEX "public"."orders_user_created_idx"`);
        await queryRunner.query(`DROP INDEX "public"."orders_new_created_idx"`);
        await queryRunner.query(`DROP TABLE "orders"`);
        await queryRunner.query(`DROP TABLE "users"`);
        // --- hand-written, reverse of the first statement in up() ---
        await queryRunner.query(`DROP TABLE IF EXISTS "typeorm_metadata"`);
    }

}
