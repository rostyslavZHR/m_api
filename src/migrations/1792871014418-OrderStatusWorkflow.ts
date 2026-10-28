import { MigrationInterface, QueryRunner } from "typeorm";

export class OrderStatusWorkflow1792871014418 implements MigrationInterface {
    name = 'OrderStatusWorkflow1792871014418'

    public async up(queryRunner: QueryRunner): Promise<void> {
        // Hand-written: 'new' isn't in the new status set. Those orders were never paid.
        await queryRunner.query(`UPDATE "orders" SET "status" = 'cancelled' WHERE "status" = 'new'`);
        // Hand-written: TypeORM compares CHECKs (same as indexes) by name, so it never sees a changed expression unless the name is changed.
        await queryRunner.query(`ALTER TABLE "orders" DROP CONSTRAINT "orders_status_check"`);
        await queryRunner.query(`ALTER TABLE "orders" ADD CONSTRAINT "orders_status_check" CHECK (status IN ('paid', 'processing', 'shipped', 'out_for_delivery', 'delivered', 'cancelled'))`);
        // Auto-generated:
        await queryRunner.query(`DROP INDEX "public"."orders_new_created_idx"`);
        await queryRunner.query(`ALTER TABLE "orders" ALTER COLUMN "status" SET DEFAULT 'paid'`);
        await queryRunner.query(`CREATE INDEX "orders_paid_created_idx" ON "orders"  ("created_at") WHERE status = 'paid'`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Hand-written: the new CHECK goes first, so the rows can be mapped back freely.
        await queryRunner.query(`ALTER TABLE "orders" DROP CONSTRAINT "orders_status_check"`);
        // Hand-written: the old status set has no processing, out_for_delivery or delivered, so each
        // folds into its nearest old status. Without this, the old CHECK below would reject those rows.
        await queryRunner.query(`UPDATE "orders" SET "status" = 'paid' WHERE "status" = 'processing'`);
        await queryRunner.query(`UPDATE "orders" SET "status" = 'shipped' WHERE "status" = 'out_for_delivery' OR "status" = 'delivered'`);
        // Hand-written, lossy on purpose: up's 'new' → 'cancelled' is not reversed. Up merged those
        // orders into the real cancellations, and nothing records which were which, so mapping
        // 'cancelled' back to 'new' would wrongly reopen genuinely cancelled orders too.
        await queryRunner.query(`ALTER TABLE "orders" ADD CONSTRAINT "orders_status_check" CHECK (status IN ('new', 'paid', 'shipped', 'cancelled'))`);
        // Auto-generated:
        await queryRunner.query(`DROP INDEX "public"."orders_paid_created_idx"`);
        await queryRunner.query(`ALTER TABLE "orders" ALTER COLUMN "status" SET DEFAULT 'new'`);
        await queryRunner.query(`CREATE INDEX "orders_new_created_idx" ON "orders" USING btree ("created_at") WHERE (status = 'new'::text)`);
    }

}
