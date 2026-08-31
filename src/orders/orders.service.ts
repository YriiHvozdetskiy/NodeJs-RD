import { Injectable } from '@nestjs/common';
import { CatalogService } from '../catalog/catalog.service';
import { HttpProblem } from '../common/http-problem';
import { newestFirst, paginate, type Page } from '../common/cursor';

export interface OrderLine {
  product_id: number;
  qty: number;
  unit_price_cents: number;
}

export interface Order {
  id: number;
  items: OrderLine[];
  total_cents: number;
  currency: 'UAH';
  status: 'pending' | 'paid' | 'cancelled';
  created_at: string;
}

export interface CreateOrderItem {
  product_id: number;
  qty: number;
}

@Injectable()
export class OrdersService {
  private readonly orders: Order[] = [
    { id: 1, items: [{ product_id: 1, qty: 1, unit_price_cents: 260000 }], total_cents: 260000, currency: 'UAH', status: 'paid', created_at: '2026-08-10T09:00:00.000Z' },
    { id: 2, items: [{ product_id: 3, qty: 2, unit_price_cents: 45000 }], total_cents: 90000, currency: 'UAH', status: 'pending', created_at: '2026-08-11T09:00:00.000Z' },
    { id: 3, items: [{ product_id: 4, qty: 1, unit_price_cents: 2150000 }], total_cents: 2150000, currency: 'UAH', status: 'cancelled', created_at: '2026-08-12T09:00:00.000Z' },
    { id: 4, items: [{ product_id: 2, qty: 1, unit_price_cents: 380000 }, { product_id: 3, qty: 1, unit_price_cents: 45000 }], total_cents: 425000, currency: 'UAH', status: 'paid', created_at: '2026-08-13T09:00:00.000Z' },
    { id: 5, items: [{ product_id: 6, qty: 1, unit_price_cents: 1450000 }], total_cents: 1450000, currency: 'UAH', status: 'pending', created_at: '2026-08-14T09:00:00.000Z' },
  ];

  private nextId = this.orders.length + 1;

  constructor(private readonly catalog: CatalogService) {}

  page(limit: number, cursor?: string): Page<Order> {
    return paginate([...this.orders].sort(newestFirst), limit, cursor);
  }

  find(id: number): Order | undefined {
    return this.orders.find((o) => o.id === id);
  }

  create(items: CreateOrderItem[]): Order {
    const lines: OrderLine[] = items.map((line) => {
      const product = this.catalog.find(line.product_id);
      if (!product) {
        // Тіло синтаксично валідне — валідатор його пропустив. Опрацювати не
        // можна: це рівно те, для чого існує 422, а не 400.
        throw new HttpProblem(422, `товару ${line.product_id} немає в каталозі`, 'unknown-product');
      }
      // Ціну КОПІЮЄМО в замовлення. Читати її з каталогу під час показу
      // означало б переписувати історію оплачених замовлень при зміні цінника.
      return { product_id: product.id, qty: line.qty, unit_price_cents: product.price_cents };
    });

    const order: Order = {
      id: this.nextId++,
      items: lines,
      // Цілі копійки: множення й додавання лишаються в integer, тож 0.1 + 0.2
      // тут неможливе за побудовою.
      total_cents: lines.reduce((sum, l) => sum + l.unit_price_cents * l.qty, 0),
      currency: 'UAH',
      status: 'pending',
      created_at: new Date().toISOString(),
    };
    this.orders.push(order);
    return order;
  }
}
