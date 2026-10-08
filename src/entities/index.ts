import { IdempotencyKey } from './idempotency-key.entity';
import { Job } from './job.entity';
import { OrderItem } from './order-item.entity';
import { Order } from './order.entity';
import { OutboxEvent } from './outbox-event.entity';
import { Payment } from './payment.entity';
import { PointsEntry } from './points-entry.entity';
import { ProcessedMessage } from './processed-message.entity';
import { Product } from './product.entity';
import { Promotion } from './promotion.entity';
import { User } from './user.entity';

export { IdempotencyKey, Job, Order, OrderItem, OutboxEvent, Payment, PointsEntry, ProcessedMessage, Product, Promotion, User };

/**
 * Повний перелік для DataSource — сім таблиць схеми з #12, черга задач з #14 і
 * три таблиці доставки подій з #22: outbox, inbox споживача, ключі ідемпотентності.
 */
export const entities = [User, Product, Promotion, Order, OrderItem, Payment, PointsEntry, Job, OutboxEvent, ProcessedMessage, IdempotencyKey];
