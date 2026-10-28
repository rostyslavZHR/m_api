import { MigrationInterface, QueryRunner } from "typeorm";

export class BackfillOrderEvents1792962470574 implements MigrationInterface {
    name = 'BackfillOrderEvents1792962470574'

    // Hand-written: one synthetic creation event (null → current status) per order with no
    // events yet, so a fresh SSE connection to an older order shows a history. Orders that
    // already have events are skipped: a creation event added now would get a later id than
    // their real changes and would replay after them.
    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            INSERT INTO "order_events" ("order_id", "from_status", "to_status", "created_at")
            SELECT o."id", NULL, o."status", o."created_at"
            FROM "orders" o
            WHERE NOT EXISTS (SELECT 1 FROM "order_events" e WHERE e."order_id" = o."id")
            ORDER BY o."id"`);
    }

    // Not reversed: a backfilled row looks exactly like a checkout creation event, so nothing
    // tells them apart. InitOrderEvent's down drops the whole table anyway.
    public async down(): Promise<void> {}

}
