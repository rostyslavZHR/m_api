import { MigrationInterface, QueryRunner } from "typeorm";

export class AddInvoiceEmails1795108320341 implements MigrationInterface {
    name = 'AddInvoiceEmails1795108320341'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "invoice_emails" ("order_id" bigint NOT NULL, "sent_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_fa7381fe21c6bfcba24774232b9" PRIMARY KEY ("order_id"))`);
        await queryRunner.query(`ALTER TABLE "invoice_emails" ADD CONSTRAINT "FK_fa7381fe21c6bfcba24774232b9" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "invoice_emails" DROP CONSTRAINT "FK_fa7381fe21c6bfcba24774232b9"`);
        await queryRunner.query(`DROP TABLE "invoice_emails"`);
    }

}
