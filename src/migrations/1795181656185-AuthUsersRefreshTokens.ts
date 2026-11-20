import { MigrationInterface, QueryRunner } from "typeorm";

export class AuthUsersRefreshTokens1795181656185 implements MigrationInterface {
    name = 'AuthUsersRefreshTokens1795181656185'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "refresh_tokens" ("id" bigint GENERATED ALWAYS AS IDENTITY NOT NULL, "user_id" bigint NOT NULL, "token_hash" text NOT NULL, "family_id" uuid NOT NULL, "used_at" TIMESTAMP WITH TIME ZONE, "revoked_at" TIMESTAMP WITH TIME ZONE, "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_7d8bee0204106019488c4c50ffa" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "refresh_tokens_user_id_idx" ON "refresh_tokens"  ("user_id") `);
        await queryRunner.query(`CREATE INDEX "refresh_tokens_family_id_idx" ON "refresh_tokens"  ("family_id") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"  ("token_hash") `);
        await queryRunner.query(`ALTER TABLE "users" ADD "password_hash" text`);
        await queryRunner.query(`ALTER TABLE "users" ADD "role" text NOT NULL DEFAULT 'customer'`);
        await queryRunner.query(`ALTER TABLE "users" ADD CONSTRAINT "users_role_check" CHECK (role IN ('customer', 'seller', 'admin'))`);
        await queryRunner.query(`ALTER TABLE "refresh_tokens" ADD CONSTRAINT "FK_3ddc983c5f7bcf132fd8732c3f4" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "refresh_tokens" DROP CONSTRAINT "FK_3ddc983c5f7bcf132fd8732c3f4"`);
        await queryRunner.query(`ALTER TABLE "users" DROP CONSTRAINT "users_role_check"`);
        await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "role"`);
        await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "password_hash"`);
        await queryRunner.query(`DROP INDEX "public"."refresh_tokens_token_hash_key"`);
        await queryRunner.query(`DROP INDEX "public"."refresh_tokens_family_id_idx"`);
        await queryRunner.query(`DROP INDEX "public"."refresh_tokens_user_id_idx"`);
        await queryRunner.query(`DROP TABLE "refresh_tokens"`);
    }

}
