import { MigrationInterface, QueryRunner } from "typeorm";

// Written by hand. init.sql's default privileges give app_user read-write access to
// every table admin creates, which includes TypeORM's own bookkeeping. The runtime
// user has no reason to rewrite schema history, so it keeps SELECT only there.
// typeorm_metadata is created only when TypeORM needs it (views, generated
// columns), so it may not exist on a fresh database.
export class RuntimeReadOnlySchemaHistory1791300000000 implements MigrationInterface {
    name = 'RuntimeReadOnlySchemaHistory1791300000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`REVOKE INSERT, UPDATE, DELETE ON "migrations" FROM app_user`);
        await queryRunner.query(`DO $$ BEGIN
            IF to_regclass('public.typeorm_metadata') IS NOT NULL THEN
                REVOKE INSERT, UPDATE, DELETE ON "typeorm_metadata" FROM app_user;
            END IF;
        END $$`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DO $$ BEGIN
            IF to_regclass('public.typeorm_metadata') IS NOT NULL THEN
                GRANT INSERT, UPDATE, DELETE ON "typeorm_metadata" TO app_user;
            END IF;
        END $$`);
        await queryRunner.query(`GRANT INSERT, UPDATE, DELETE ON "migrations" TO app_user`);
    }
}
