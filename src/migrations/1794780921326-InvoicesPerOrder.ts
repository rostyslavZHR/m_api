import { MigrationInterface, QueryRunner } from "typeorm";

export class InvoicesPerOrder1794780921326 implements MigrationInterface {
    name = 'InvoicesPerOrder1794780921326'

    // Hand-written (the generated one named the constraint UQ_<hash> and dropped and
    // re-added the FK for nothing). Dedup moves from event_id to the natural key
    // order_id (level 1) plus processed_messages (level 2), so event_id goes.
    // Fails if an order already has two invoices: check and clean those up first
    // (SELECT order_id, count(*) FROM invoices GROUP BY order_id HAVING count(*) > 1).
    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "invoices" DROP CONSTRAINT "invoices_event_id_key"`);
        await queryRunner.query(`ALTER TABLE "invoices" DROP COLUMN "event_id"`);
        await queryRunner.query(`ALTER TABLE "invoices" ADD CONSTRAINT "invoices_order_id_key" UNIQUE ("order_id")`);
    }

    // The old event ids can't come back: event_id returns nullable and empty. Unique
    // still holds (NULLs don't collide).
    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "invoices" DROP CONSTRAINT "invoices_order_id_key"`);
        await queryRunner.query(`ALTER TABLE "invoices" ADD "event_id" bigint`);
        await queryRunner.query(`ALTER TABLE "invoices" ADD CONSTRAINT "invoices_event_id_key" UNIQUE ("event_id")`);
    }

}
