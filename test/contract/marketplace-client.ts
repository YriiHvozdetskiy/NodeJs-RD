import { z } from 'zod';

/**
 * Клієнт уявного фронтенду marketplace-web — той код, що в браузері ходить в
 * API. Consumer-тест ганяє саме його, а не голий fetch: контракт фіксує те, на
 * що спирається справжній клієнт, а не те, що тест вигадав окремо.
 *
 * Базова адреса вже містить версію (`https://api.marketplace.example/v1` у
 * проді) — так само, як `servers.url` у спеці. Тому шляхи тут, у контракті й у
 * спеці однакові: `/orders/{orderId}`.
 */
const OrderSchema = z.object({
  id: z.number().int(),
  items: z.array(z.object({ product_id: z.number().int(), qty: z.number().int(), unit_price_cents: z.number().int() })),
  total_cents: z.number().int(),
  currency: z.string(),
  status: z.enum(['pending', 'paid', 'cancelled']),
  created_at: z.string(),
});

const ProblemSchema = z.object({ type: z.string(), status: z.number(), detail: z.string() });

export type OrderDto = z.infer<typeof OrderSchema>;

/** Фронтенд розрізняє помилки за `type` з problem+json, а не за текстом. */
export class ApiProblem extends Error {
  constructor(
    readonly type: string,
    readonly status: number,
    detail: string,
  ) {
    super(detail);
  }
}

export class MarketplaceClient {
  constructor(private readonly baseUrl: string) {}

  async getOrder(id: number): Promise<OrderDto> {
    const res = await fetch(`${this.baseUrl}/orders/${id}`, { headers: { Accept: 'application/json' } });
    return OrderSchema.parse(await this.body(res));
  }

  async createOrder(items: { product_id: number; qty: number }[], idempotencyKey: string): Promise<{ order: OrderDto; location: string | null }> {
    const res = await fetch(`${this.baseUrl}/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify({ items }),
    });
    return { order: OrderSchema.parse(await this.body(res)), location: res.headers.get('location') };
  }

  private async body(res: Response): Promise<unknown> {
    const body: unknown = await res.json();
    if (res.ok) return body;
    const problem = ProblemSchema.parse(body);
    throw new ApiProblem(problem.type, problem.status, problem.detail);
  }
}
