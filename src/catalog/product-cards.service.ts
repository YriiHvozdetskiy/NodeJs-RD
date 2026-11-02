import { Injectable, Logger } from '@nestjs/common';
import { CacheAside, type CacheAsideOptions } from '../cache/cache-aside';
import { RedisConnections } from '../redis/redis-connections';
import { ProductsRepository, type ProductCard } from './products.repository';

/**
 * TTL картки — 300 + random(0..60) с. Картка показує залишок, а його міняє
 * кожне замовлення; тому, крім TTL, checkout явно скидає картки своїх товарів
 * (OrdersService.create). Застарілий залишок у картці — прийнятна брехня:
 * checkout перевіряє справжній атомарним UPDATE … WHERE stock >= n і на
 * нестачу відповідає 409, хоч би що показала картка.
 */
export const CARD_CACHE: CacheAsideOptions = {
  ttlSeconds: 300,
  ttlJitterSeconds: 60,
  missingTtlSeconds: 30,
  lockTtlMs: 5_000,
  pollMs: 25,
};

/**
 * `v1` у ключі — версія форми картки. Змінилась форма — новий префікс, і
 * старі записи не читаються новим кодом, а просто доживають свій TTL.
 */
export function cardKey(id: number): string {
  return `card:v1:${id}`;
}

/** Як часто можна писати в лог про ту саму недоступність Redis. */
const WARN_EVERY_MS = 10_000;

@Injectable()
export class ProductCardsService {
  private readonly logger = new Logger('ProductCards');
  private readonly cache: CacheAside;
  private lastWarnAt = 0;

  constructor(
    private readonly products: ProductsRepository,
    connections: RedisConnections,
  ) {
    this.cache = new CacheAside(connections.cache, CARD_CACHE, (op, err) => this.warn(op, err));
  }

  get(id: number): Promise<ProductCard | null> {
    // id поза bigint у кеш не йде: інакше кожен такий запит лишав би ключ.
    if (!Number.isSafeInteger(id) || id < 1) return Promise.resolve(null);
    return this.cache.get(cardKey(id), () => this.products.findCard(id));
  }

  invalidate(ids: number[]): Promise<void> {
    return this.cache.invalidate([...new Set(ids)].map(cardKey));
  }

  private warn(op: string, err: unknown): void {
    const now = Date.now();
    if (now - this.lastWarnAt < WARN_EVERY_MS) return;
    this.lastWarnAt = now;
    this.logger.warn(`кеш недоступний (${op}): ${err instanceof Error ? err.message : String(err)} — читаю з бази`);
  }
}
