import { MigrationInterface, QueryRunner } from "typeorm";

export class AddFiles1795385599241 implements MigrationInterface {
    name = 'AddFiles1795385599241'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "files" ("id" uuid NOT NULL, "key" text NOT NULL, "owner_id" bigint NOT NULL, "status" text NOT NULL DEFAULT 'PENDING', "content_type" text NOT NULL, "size" bigint NOT NULL, "upload_id" text, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "completed_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "files_key_key" UNIQUE ("key"), CONSTRAINT "files_size_check" CHECK (size > 0), CONSTRAINT "files_status_check" CHECK (status IN ('PENDING', 'COMPLETED')), CONSTRAINT "PK_6c16b9093a142e0e7613b04a3d9" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "files_owner_id_idx" ON "files"  ("owner_id") `);
        await queryRunner.query(`ALTER TABLE "files" ADD CONSTRAINT "FK_4bc1db1f4f34ec9415acd88afdb" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "files" DROP CONSTRAINT "FK_4bc1db1f4f34ec9415acd88afdb"`);
        await queryRunner.query(`DROP INDEX "public"."files_owner_id_idx"`);
        await queryRunner.query(`DROP TABLE "files"`);
    }

}
