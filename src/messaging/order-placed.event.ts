import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { CheckoutResult } from '../checkout/checkout';
import { ORDER_PLACED } from './topology';

/**
 * Контракт події order.placed, v1 — те, що бачать УСІ майбутні споживачі
 * (бали зараз; outbox на #22 і BullMQ на #23 візьмуть рівно цю подію).
 *
 * Свідомо спроектований конверт, а не ORM-сутність через spread: сутність
 * змінюється разом зі схемою БД, а контракт — лише разом із `version`. Поля
 * замовлення, яких немає тут (знижки, бали, промокод), споживач читає з бази
 * за orderId, якщо вони йому справді потрібні.
 *
 *   eventId     стабільний ідентифікатор події — за ним упізнають дубль
 *   type        дублює routing key: повідомлення, перекладене в DLQ чи інший
 *               exchange, не губить, чим воно було
 *   version     номер форми `data`; незнайома версія — відмова, а не здогадка
 *   occurredAt  коли замовлення стало фактом (orders.created_at), а не коли
 *               подію відправили: повтор публікації не змінює часу події
 *
 * Схема — zod, і тип виводиться з неї, як Env з env.schema.ts: те, що
 * перевіряє споживач, і те, що будує продюсер, не можуть розійтися.
 */
const id = z.string().regex(/^\d+$/, 'bigint рядком');

export const orderPlacedSchema = z.object({
  eventId: z.uuid(),
  type: z.literal(ORDER_PLACED),
  version: z.literal(1),
  occurredAt: z.iso.datetime(),
  data: z.object({
    orderId: id,
    buyerId: id,
    currency: z.string().regex(/^[A-Z]{3}$/),
    totalCents: z.number().int().min(0),
    items: z.array(z.object({ productId: id, qty: z.number().int().positive() })).min(1),
  }),
});

export type OrderPlacedEvent = z.infer<typeof orderPlacedSchema>;

export type OrderPlacedFacts = Pick<CheckoutResult, 'orderId' | 'buyerId' | 'currency' | 'totalCents' | 'placedAt' | 'lines'>;

/** `aggregate_type` рядка outbox (#22): подія про замовлення. У Debezium це став би топік. */
export const ORDER_AGGREGATE = 'order';

/**
 * Явна функція «замовлення → контракт», а не `{ ...order }`: кожне поле події
 * назване тут, і перейменування колонки чи поля CheckoutResult ламає
 * компіляцію цього файла, а не споживачів у проді.
 */
export function toOrderPlacedEvent(order: OrderPlacedFacts): OrderPlacedEvent {
  return {
    eventId: orderPlacedEventId(order.orderId),
    type: ORDER_PLACED,
    version: 1,
    occurredAt: order.placedAt,
    data: {
      orderId: order.orderId,
      buyerId: order.buyerId,
      currency: order.currency,
      totalCents: order.totalCents,
      items: order.lines.map(({ productId, qty }) => ({ productId, qty })),
    },
  };
}

/**
 * Битий контракт: не JSON, не та форма, не та версія. Повторна доставка дасть
 * рівно той самий результат, тому таке повідомлення не повертають у чергу, а
 * відразу віддають у DLX — `reject(requeue=false)`, причина `rejected`.
 */
export class ContractError extends Error {
  override readonly name = 'ContractError';
}

export function parseOrderPlaced(content: Buffer): OrderPlacedEvent {
  let raw: unknown;
  try {
    raw = JSON.parse(content.toString('utf8'));
  } catch {
    throw new ContractError('тіло повідомлення — не JSON');
  }
  const parsed = orderPlacedSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ContractError(parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; '));
  }
  return parsed.data;
}

/**
 * UUID v5 (RFC 9562, name-based, SHA-1) від `order.placed:<orderId>`.
 *
 * Стабільний за побудовою, а не «згенерований один раз і збережений»: на одне
 * замовлення рівно одна подія order.placed, тож будь-хто — повтор публікації
 * після таймауту confirm, ручний redrive з DLQ, relay outbox на #22 — отримає
 * той самий eventId. Випадковий UUID на кожну спробу публікації зробив би
 * кожну спробу окремою подією, і дедуплікувати було б нема за чим.
 */
const EVENT_ID_NAMESPACE = 'ffe1214d-7cea-460f-8298-6c2d7d093eed';

export function orderPlacedEventId(orderId: string): string {
  const hash = createHash('sha1')
    .update(Buffer.from(EVENT_ID_NAMESPACE.replaceAll('-', ''), 'hex'))
    .update(`${ORDER_PLACED}:${orderId}`)
    .digest();
  hash[6] = (hash[6] & 0x0f) | 0x50; // версія 5
  hash[8] = (hash[8] & 0x3f) | 0x80; // варіант RFC
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
