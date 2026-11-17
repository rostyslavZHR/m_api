import { MigrationInterface, QueryRunner } from "typeorm";

export class AddInvoices1794074431947 implements MigrationInterface {
    name = 'AddInvoices1794074431947'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "invoices" ("id" bigint GENERATED ALWAYS AS IDENTITY NOT NULL, "event_id" bigint NOT NULL, "order_id" bigint NOT NULL, "total_cents" bigint NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "invoices_event_id_key" UNIQUE ("event_id"), CONSTRAINT "PK_668cef7c22a427fd822cc1be3ce" PRIMARY KEY ("id"))`);
        await queryRunner.query(`ALTER TABLE "invoices" ADD CONSTRAINT "FK_ea83c3b911906a3578de2340fdf" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "invoices" DROP CONSTRAINT "FK_ea83c3b911906a3578de2340fdf"`);
        await queryRunner.query(`DROP TABLE "invoices"`);
    }

}
