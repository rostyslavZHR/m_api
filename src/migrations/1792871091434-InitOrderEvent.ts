import { MigrationInterface, QueryRunner } from "typeorm";

export class InitOrderEvent1792871091434 implements MigrationInterface {
    name = 'InitOrderEvent1792871091434'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "order_events" ("id" bigint GENERATED ALWAYS AS IDENTITY NOT NULL, "from_status" text, "to_status" text NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "order_id" bigint NOT NULL, CONSTRAINT "PK_cc1b82b0fcf1be577d9d7ecbf8b" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "order_events_order_id_idx" ON "order_events"  ("order_id", "id") `);
        await queryRunner.query(`ALTER TABLE "order_events" ADD CONSTRAINT "FK_b33cbf9a59cbee112d94bcb59de" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "order_events" DROP CONSTRAINT "FK_b33cbf9a59cbee112d94bcb59de"`);
        await queryRunner.query(`DROP INDEX "public"."order_events_order_id_idx"`);
        await queryRunner.query(`DROP TABLE "order_events"`);
    }

}
