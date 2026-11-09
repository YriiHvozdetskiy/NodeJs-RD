import { randomBytes } from 'node:crypto';
import type { DataSource } from 'typeorm';
import type { UserRole } from '../entities/user.entity';
import type { Api } from '../redis/demo-kit';
import { hashPassword } from './passwords';

/**
 * Спільне для demo:auth, demo:reuse і demo:rbac. Як і демо #22/#23, кожне:
 *   1. саме доводить базу до схеми й піднімає справжній AppModule на
 *      ефемерному порту — грейдеру не потрібні ні `migrate`, ні `start`;
 *   2. створює власних користувачів і прибирає їх (разом із хвостами
 *      попереднього прогону, якщо той упав посередині);
 *   3. друкує ключ=HTTP-статус і саме перевіряє інваріанти — код виходу.
 *
 * Порт — 0: ядро ОС видає вільний, тож EADDRINUSE від забутого процесу
 * попереднього прогону не буває, а застосунок живе в процесі демо і
 * закривається разом із ним.
 */

export interface DemoUser {
  id: string;
  email: string;
  password: string;
  role: UserRole;
}

export interface Reply {
  status: number;
  json: unknown;
}

export interface Tokens {
  access: string;
  refresh: string;
}

/** Домен пошти демо-користувачів: за ним прибирання знаходить і свої, і забуті рядки. */
export const demoDomain = (demo: string): string => `${demo}.demo.marketplace.test`;

export async function call(
  api: Api,
  method: 'GET' | 'POST',
  path: string,
  options: { token?: string; body?: unknown } = {},
): Promise<Reply> {
  const headers: Record<string, string> = {};
  if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${api.url}/v1${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

function isTokenPair(json: unknown): json is { access_token: string; refresh_token: string } {
  return (
    typeof json === 'object' &&
    json !== null &&
    'access_token' in json &&
    typeof json.access_token === 'string' &&
    'refresh_token' in json &&
    typeof json.refresh_token === 'string'
  );
}

/** Пара з відповіді login/refresh; не пара — порожні рядки, і наступні кроки дадуть 401. */
export function tokensOf(reply: Reply): Tokens {
  return isTokenPair(reply.json) ? { access: reply.json.access_token, refresh: reply.json.refresh_token } : { access: '', refresh: '' };
}

/** `detail` із problem+json — щоб у лозі демо було видно ЧОМУ, а не лише код. */
export function detailOf(reply: Reply): string {
  const json = reply.json;
  return typeof json === 'object' && json !== null && 'detail' in json && typeof json.detail === 'string' ? json.detail : '';
}

/**
 * Демо-користувач із випадковим паролем, захешованим тим самим scrypt, що й
 * справжні. Email — під доменом цього демо: прибирання знаходить його за ним.
 */
export async function createUser(dataSource: DataSource, demo: string, name: string, role: UserRole): Promise<DemoUser> {
  const email = `${name}-${randomBytes(3).toString('hex')}@${demoDomain(demo)}`;
  const password = randomBytes(12).toString('base64url');
  const rows: { id: string }[] = await dataSource.query(
    `INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3) RETURNING id`,
    [email, await hashPassword(password), role],
  );
  return { id: rows[0].id, email, password, role };
}

/**
 * Прибрати все, що лишили демо-користувачі цього демо: замовлення з
 * позиціями, товари, самих користувачів. refresh_tokens ідуть каскадом за
 * users (ON DELETE CASCADE), ключі ідемпотентності — за orders.
 */
export async function cleanup(dataSource: DataSource, demo: string): Promise<void> {
  const users = `SELECT id FROM users WHERE email LIKE '%@' || $1`;
  await dataSource.query(
    `DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE buyer_id IN (${users}))
        OR product_id IN (SELECT id FROM products WHERE seller_id IN (${users}))`,
    [demoDomain(demo)],
  );
  await dataSource.query(`DELETE FROM orders WHERE buyer_id IN (${users})`, [demoDomain(demo)]);
  await dataSource.query(`DELETE FROM products WHERE seller_id IN (${users})`, [demoDomain(demo)]);
  await dataSource.query(`DELETE FROM users WHERE email LIKE '%@' || $1`, [demoDomain(demo)]);
}

export function login(api: Api, user: DemoUser): Promise<Reply> {
  return call(api, 'POST', '/auth/login', { body: { email: user.email, password: user.password } });
}

/**
 * Той самий access-токен із підміненим payload і СТАРИМ підписом — рівно
 * трирядковий node -e з умови ДЗ. Ключ для цього не потрібен: payload у JWS
 * не зашифрований, а лише закодований base64url. Рішення на `jwt.decode()`
 * таку підробку пропустило б.
 */
export function tamper(token: string, patch: Record<string, unknown>): string {
  const parts = token.split('.');
  const payload: unknown = JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString());
  parts[1] = Buffer.from(JSON.stringify({ ...(typeof payload === 'object' ? payload : {}), ...patch })).toString('base64url');
  return parts.join('.');
}

/**
 * Claims без перевірки підпису — лише щоб демо знало jti і fid і подивилось
 * на їхні записи в Redis. Рішення на такому читанні не ухвалюються ніде:
 * саме від цього захищає tamper вище.
 */
export function claimsOf(token: string): { jti: string; fid: string } {
  const payload: unknown = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString());
  const read = (key: string): string => {
    const value: unknown = typeof payload === 'object' && payload !== null ? Reflect.get(payload, key) : undefined;
    return typeof value === 'string' ? value : '';
  };
  return { jti: read('jti'), fid: read('fid') };
}
