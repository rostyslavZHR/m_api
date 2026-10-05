import { MigrationInterface, QueryRunner } from "typeorm";

// Hand-written. Money moves from numeric(12,2) to integer minor units (cents),
// as the brief asks. migration:generate can't express this: it sees a renamed
// column as DROP + ADD, which would lose every price. So each column is renamed
// and converted in place, keeping its data: 3499.00 → 349900.
//
// Init already ran on other databases, so it isn't edited — this is a new
// migration on top of it.
export class MoneyToMinorUnits1791227100000 implements MigrationInterface {
    name = 'MoneyToMinorUnits1791227100000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "products" DROP CONSTRAINT "products_price_check"`);
        await queryRunner.query(`ALTER TABLE "products" RENAME COLUMN "price" TO "price_cents"`);
        await queryRunner.query(`ALTER TABLE "products" ALTER COLUMN "price_cents" TYPE bigint USING round("price_cents" * 100)::bigint`);
        await queryRunner.query(`ALTER TABLE "products" ADD CONSTRAINT "products_price_cents_check" CHECK (price_cents >= 0)`);

        await queryRunner.query(`ALTER TABLE "orders" DROP CONSTRAINT "orders_total_check"`);
        await queryRunner.query(`ALTER TABLE "orders" RENAME COLUMN "total" TO "total_cents"`);
        await queryRunner.query(`ALTER TABLE "orders" ALTER COLUMN "total_cents" TYPE bigint USING round("total_cents" * 100)::bigint`);
        await queryRunner.query(`ALTER TABLE "orders" ADD CONSTRAINT "orders_total_cents_check" CHECK (total_cents >= 0)`);

        await queryRunner.query(`ALTER TABLE "order_items" DROP CONSTRAINT "order_items_unit_price_check"`);
        await queryRunner.query(`ALTER TABLE "order_items" RENAME COLUMN "unit_price" TO "unit_price_cents"`);
        await queryRunner.query(`ALTER TABLE "order_items" ALTER COLUMN "unit_price_cents" TYPE bigint USING round("unit_price_cents" * 100)::bigint`);
        await queryRunner.query(`ALTER TABLE "order_items" ADD CONSTRAINT "order_items_unit_price_cents_check" CHECK (unit_price_cents >= 0)`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "order_items" DROP CONSTRAINT "order_items_unit_price_cents_check"`);
        await queryRunner.query(`ALTER TABLE "order_items" ALTER COLUMN "unit_price_cents" TYPE numeric(12,2) USING "unit_price_cents" / 100.0`);
        await queryRunner.query(`ALTER TABLE "order_items" RENAME COLUMN "unit_price_cents" TO "unit_price"`);
        await queryRunner.query(`ALTER TABLE "order_items" ADD CONSTRAINT "order_items_unit_price_check" CHECK (unit_price >= 0)`);

        await queryRunner.query(`ALTER TABLE "orders" DROP CONSTRAINT "orders_total_cents_check"`);
        await queryRunner.query(`ALTER TABLE "orders" ALTER COLUMN "total_cents" TYPE numeric(12,2) USING "total_cents" / 100.0`);
        await queryRunner.query(`ALTER TABLE "orders" RENAME COLUMN "total_cents" TO "total"`);
        await queryRunner.query(`ALTER TABLE "orders" ADD CONSTRAINT "orders_total_check" CHECK (total >= 0)`);

        await queryRunner.query(`ALTER TABLE "products" DROP CONSTRAINT "products_price_cents_check"`);
        await queryRunner.query(`ALTER TABLE "products" ALTER COLUMN "price_cents" TYPE numeric(12,2) USING "price_cents" / 100.0`);
        await queryRunner.query(`ALTER TABLE "products" RENAME COLUMN "price_cents" TO "price"`);
        await queryRunner.query(`ALTER TABLE "products" ADD CONSTRAINT "products_price_check" CHECK (price >= 0)`);
    }

}
