import { Injectable } from '@nestjs/common';
import { newestFirst, paginate, type Page } from '../common/cursor';

export interface Product {
  id: number;
  title: string;
  price_cents: number;
  currency: 'UAH';
  created_at: string;
}

/**
 * Каталог у памʼяті. На #12 це стане схемою Postgres, на #13 — TypeORM-entity,
 * і саме тому він уже провайдер: контролер отримує його через DI і не знає,
 * звідки дані. Заміна сховища не торкнеться контролера.
 *
 * Товари 4 і 5 мають ОДНАКОВИЙ created_at навмисно — на них видно, чому в
 * курсорі є id.
 */
@Injectable()
export class CatalogService {
  private readonly products: Product[] = [
    { id: 1, title: 'Клавіатура Keychron K2', price_cents: 260000, currency: 'UAH', created_at: '2026-08-01T10:00:00.000Z' },
    { id: 2, title: 'Мишка Logitech MX Master', price_cents: 380000, currency: 'UAH', created_at: '2026-08-02T10:00:00.000Z' },
    { id: 3, title: 'Килимок Razer Goliathus', price_cents: 45000, currency: 'UAH', created_at: '2026-08-03T10:00:00.000Z' },
    { id: 4, title: 'Монітор Dell U2723QE', price_cents: 2150000, currency: 'UAH', created_at: '2026-08-04T10:00:00.000Z' },
    { id: 5, title: 'USB-C хаб Anker 555', price_cents: 320000, currency: 'UAH', created_at: '2026-08-04T10:00:00.000Z' },
    { id: 6, title: 'Навушники Sony WH-1000XM5', price_cents: 1450000, currency: 'UAH', created_at: '2026-08-05T10:00:00.000Z' },
    { id: 7, title: 'Веб-камера Logitech Brio', price_cents: 690000, currency: 'UAH', created_at: '2026-08-06T10:00:00.000Z' },
  ];

  page(limit: number, cursor?: string): Page<Product> {
    return paginate([...this.products].sort(newestFirst), limit, cursor);
  }

  find(id: number): Product | undefined {
    return this.products.find((p) => p.id === id);
  }
}
