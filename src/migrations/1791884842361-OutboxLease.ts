import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * #22, після ревʼю: оренда рядка outbox замість локу на весь прохід relay.
 *
 * Згенеровано `migration:generate` з entity OutboxEvent. Окремою міграцією, а
 * не правкою OutboxInbox: та вже застосована на базах, де її запускали, і
 * TypeORM вдруге її не виконає.
 *
 * `locked_until` — до цієї миті рядок належить relay, що його взяв. Завдяки
 * цьому `attempts + 1` комітиться ДО publish і переживає relay, убитий
 * посеред публікації (src/outbox/relay.ts). Частковий індекс relay не
 * змінюється: умова оренди — фільтр поверх рядків, які він уже віддає.
 *
 * Наявні рядки отримують NULL — «вільний», як і належить невинесеному.
 */
export class OutboxLease1791884842361 implements MigrationInterface {
    name = 'OutboxLease1791884842361'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "outbox" ADD "locked_until" TIMESTAMP WITH TIME ZONE`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "outbox" DROP COLUMN "locked_until"`);
    }

}
