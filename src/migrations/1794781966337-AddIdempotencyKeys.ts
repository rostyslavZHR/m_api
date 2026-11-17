import { MigrationInterface, QueryRunner } from "typeorm";

export class AddIdempotencyKeys1794781966337 implements MigrationInterface {
    name = 'AddIdempotencyKeys1794781966337'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "idempotency_keys" ("user_id" bigint NOT NULL, "key" uuid NOT NULL, "fingerprint" text NOT NULL, "order_id" bigint, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_392b1af86f210d98d3f0c764728" PRIMARY KEY ("user_id", "key"))`);
        await queryRunner.query(`ALTER TABLE "idempotency_keys" ADD CONSTRAINT "FK_4d2181624ba2d61e76a07175198" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "idempotency_keys" ADD CONSTRAINT "FK_446856502ff1075430219299f33" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "idempotency_keys" DROP CONSTRAINT "FK_446856502ff1075430219299f33"`);
        await queryRunner.query(`ALTER TABLE "idempotency_keys" DROP CONSTRAINT "FK_4d2181624ba2d61e76a07175198"`);
        await queryRunner.query(`DROP TABLE "idempotency_keys"`);
    }

}
