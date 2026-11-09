import { createHash } from 'node:crypto';
import type { ObjectStorage } from './object-storage';

/**
 * Публічні ассети (#26): CSS, JS, іконки вітрини. Лежать у тому самому
 * приватному бакеті під `assets/` і роздаються лише через кеш-шар (src/edge.ts).
 *
 * Оновлення без інвалідації: імʼя містить хеш вмісту — `app.15c42ab7.css`.
 * Новий вміст — нове імʼя — новий URL. Старий запис у кешах (наш edge,
 * CDN, браузер, корпоративний проксі) нікому не заважає: на нього більше
 * ніхто не посилається. Інвалідацій — нуль, і вони не потрібні.
 */

/**
 * Рік кешу і `immutable`: вміст за цим URL не зміниться ніколи, тож ні кеш, ні
 * браузер навіть на F5 не роблять умовного запиту.
 *
 * 🔴 Заголовок ставиться на ОБʼЄКТ під час завантаження, а не в edge: кеш
 * читає його з origin. Немає Cache-Control на обʼєкті — кешувати нічого.
 */
export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';

/** `app` + `css` + вміст → `app.15c42ab7.css`. 8 hex sha256 — 32 біти, на вітрину досить. */
export function hashedName(name: string, ext: string, body: Buffer): string {
  const hash = createHash('sha256').update(body).digest('hex').slice(0, 8);
  return `${name}.${hash}.${ext}`;
}

export interface Asset {
  /** Каталог під `assets/`, без слешів на краях: `storefront`. */
  dir: string;
  name: string;
  ext: string;
  contentType: string;
  body: Buffer;
}

/** «Деплой» ассета: ключ із хешем вмісту, обʼєкт із Cache-Control. Повертає ключ. */
export async function publishAsset(storage: ObjectStorage, asset: Asset): Promise<string> {
  const key = `assets/${asset.dir}/${hashedName(asset.name, asset.ext, asset.body)}`;
  await storage.put(key, asset.body, { contentType: asset.contentType, cacheControl: IMMUTABLE_CACHE_CONTROL });
  return key;
}
