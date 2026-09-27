import { OrderItem } from './order-item.entity';
import { Order } from './order.entity';
import { Payment } from './payment.entity';
import { PointsEntry } from './points-entry.entity';
import { Product } from './product.entity';
import { Promotion } from './promotion.entity';
import { User } from './user.entity';

export { Order, OrderItem, Payment, PointsEntry, Product, Promotion, User };

/** Повний перелік для DataSource — сім таблиць схеми з #12. */
export const entities = [User, Product, Promotion, Order, OrderItem, Payment, PointsEntry];
