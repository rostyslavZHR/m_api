import { MigrationInterface, QueryRunner } from "typeorm";

export class AddOutbox1794769025351 implements MigrationInterface {
    name = 'AddOutbox1794769025351'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "outbox" ("id" uuid NOT NULL, "aggregate_type" text NOT NULL, "aggregate_id" text NOT NULL, "type" text NOT NULL, "payload" jsonb NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "published_at" TIMESTAMP WITH TIME ZONE, "attempts" integer NOT NULL DEFAULT '0', CONSTRAINT "PK_340ab539f309f03bdaa14aa7649" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "outbox_unpublished_idx" ON "outbox"  ("created_at", "id") WHERE "published_at" IS NULL`);
        await queryRunner.query(`CREATE TABLE "processed_messages" ("message_id" uuid NOT NULL, "consumer" text NOT NULL, "processed_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_d4853eee97acfc588e49f9290d1" PRIMARY KEY ("message_id", "consumer"))`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "processed_messages"`);
        await queryRunner.query(`DROP INDEX "public"."outbox_unpublished_idx"`);
        await queryRunner.query(`DROP TABLE "outbox"`);
    }

}
