import { MigrationInterface, QueryRunner } from "typeorm";

// Generated, then simplified by hand: the generator read "in_stock removed, stock
// added" as a rename, and wrote RENAME in_stock → stock followed by DROP stock +
// ADD stock (the types differ). Same result as the plain drop + add below, which
// is what's meant: the boolean is replaced, not converted, so every product starts
// at stock 0 until the seed or an admin sets it.
export class StockBalanceJobs1791229777721 implements MigrationInterface {
    name = 'StockBalanceJobs1791229777721'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "jobs" ("id" bigint GENERATED ALWAYS AS IDENTITY NOT NULL, "type" text NOT NULL, "status" text NOT NULL DEFAULT 'new', "worker" text, "processed" integer NOT NULL DEFAULT '0', "attempts" integer NOT NULL DEFAULT '0', "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "order_id" bigint, CONSTRAINT "jobs_status_check" CHECK (status IN ('new', 'running', 'done', 'failed')), CONSTRAINT "PK_cf0a6c42b72fcc7f7c237def345" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "jobs_pending_idx" ON "jobs"  ("id") WHERE status = 'new'`);
        await queryRunner.query(`ALTER TABLE "users" ADD "balance_cents" bigint NOT NULL DEFAULT '0'`);
        await queryRunner.query(`ALTER TABLE "products" DROP COLUMN "in_stock"`);
        await queryRunner.query(`ALTER TABLE "products" ADD "stock" integer NOT NULL DEFAULT '0'`);
        await queryRunner.query(`ALTER TABLE "users" ADD CONSTRAINT "users_balance_cents_check" CHECK (balance_cents >= 0)`);
        await queryRunner.query(`ALTER TABLE "products" ADD CONSTRAINT "products_stock_check" CHECK (stock >= 0)`);
        await queryRunner.query(`ALTER TABLE "jobs" ADD CONSTRAINT "FK_2cb9942b3a4fd4674ebb20406ff" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "jobs" DROP CONSTRAINT "FK_2cb9942b3a4fd4674ebb20406ff"`);
        await queryRunner.query(`ALTER TABLE "products" DROP CONSTRAINT "products_stock_check"`);
        await queryRunner.query(`ALTER TABLE "users" DROP CONSTRAINT "users_balance_cents_check"`);
        await queryRunner.query(`ALTER TABLE "products" DROP COLUMN "stock"`);
        await queryRunner.query(`ALTER TABLE "products" ADD "in_stock" boolean NOT NULL DEFAULT false`);
        await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "balance_cents"`);
        await queryRunner.query(`DROP INDEX "public"."jobs_pending_idx"`);
        await queryRunner.query(`DROP TABLE "jobs"`);
    }

}
