import 'reflect-metadata';

import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { after, before, describe, it } from 'node:test';

import { Container } from '../src/container';
import { getRequestId } from '../src/context/request-context';
import { Controller } from '../src/decorators/controller';
import { Injectable } from '../src/decorators/injectable';
import { Get } from '../src/decorators/methods';
import { Param } from '../src/decorators/params';
import { UseInterceptors } from '../src/decorators/use-guards';
import { createApp } from '../src/dispatcher';
import { LoggingInterceptor, setLogSink } from '../src/interceptors/logging.interceptor';

/**
 * Третій рівень: контролер → SurfaceService → DeepService.
 * Жоден метод не приймає requestId параметром — у цьому весь сенс.
 */
@Injectable()
class DeepService {
  async touch(label: string): Promise<{ label: string; requestId: string | undefined }> {
    // Затримка тут ОБОВʼЯЗКОВА для чесності тесту: саме на await event loop
    // перемикається на інший запит. Без неї всі запити виконались би
    // послідовно, і глобальна змінна теж «пройшла» б тест.
    await delay(Math.floor(Math.random() * 20));
    return { label, requestId: getRequestId() };
  }
}

@Injectable()
class SurfaceService {
  constructor(private readonly deep: DeepService) {}

  run(label: string): Promise<{ label: string; requestId: string | undefined }> {
    return this.deep.touch(label);
  }
}

@Controller('ctx')
@UseInterceptors(LoggingInterceptor)
class CtxController {
  constructor(private readonly surface: SurfaceService) {}

  @Get('deep/:label')
  async deep(@Param('label') label: string): Promise<{ label: string; requestId: string | undefined }> {
    return this.surface.run(label);
  }

  @Get('shallow')
  shallow(): { requestId: string | undefined } {
    return { requestId: getRequestId() };
  }
}

const container = new Container();
const server = createApp(container, [CtxController]);
let base = '';

before(async () => {
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
});

describe('X-Request-Id', () => {
  it('заголовок є у відповіді навіть без запиту клієнта', async () => {
    const response = await fetch(`${base}/ctx/shallow`);
    const header = response.headers.get('x-request-id');

    assert.ok(header !== null && header.length > 0);
    await response.text();
  });

  it('клієнтський id повертається саме той, що надіслали', async () => {
    const response = await fetch(`${base}/ctx/shallow`, {
      headers: { 'x-request-id': 'trace-from-client' },
    });

    assert.equal(response.headers.get('x-request-id'), 'trace-from-client');
    const body = await response.json();
    // І в тілі теж він — тобто у сховище потрапив клієнтський, а не новий.
    assert.equal(body.requestId, 'trace-from-client');
  });

  it('заголовок є навіть на помилці', async () => {
    const response = await fetch(`${base}/ctx/no-such`);
    await response.text();

    // Ставиться на вході, а не наприкінці: саме на впалому запиті id
    // потрібен найбільше.
    assert.equal(response.status, 404);
  });
});

describe('AsyncLocalStorage крізь глибину стека', () => {
  it('сервіс на два рівні глибше бачить той самий id', async () => {
    const response = await fetch(`${base}/ctx/deep/one`, {
      headers: { 'x-request-id': 'deep-check' },
    });
    const body = await response.json();

    // Контролер → SurfaceService → DeepService, і жодна сигнатура
    // по дорозі не має параметра з id.
    assert.equal(body.requestId, 'deep-check');
  });

  it('id переживає await всередині сервісу', async () => {
    const body = await (await fetch(`${base}/ctx/deep/two`, {
      headers: { 'x-request-id': 'after-await' },
    })).json();

    // ALS привʼязаний до ланцюжка асинхронних викликів, а не до синхронного
    // шматка коду: після await контекст той самий.
    assert.equal(body.requestId, 'after-await');
  });
});

describe('паралельні запити не змішують контексти', () => {
  it('10 одночасних запитів — кожен отримує СВІЙ id', async () => {
    const labels = Array.from({ length: 10 }, (_, i) => `req-${i}`);

    // Саме одночасно, через Promise.all: поки один чекає на delay усередині
    // DeepService, event loop бере наступний. Це той сценарій, на якому
    // глобальна змінна ламається.
    const results = await Promise.all(
      labels.map(async (label) => {
        const response = await fetch(`${base}/ctx/deep/${label}`, {
          headers: { 'x-request-id': `id-${label}` },
        });
        return response.json();
      }),
    );

    for (const result of results) {
      assert.equal(
        result.requestId,
        `id-${result.label}`,
        `у відповідь на ${result.label} протік чужий id ${result.requestId}`,
      );
    }
  });

  it('жоден id не повторився і не загубився', async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, async (_, i) => {
        const response = await fetch(`${base}/ctx/deep/x${i}`, {
          headers: { 'x-request-id': `unique-${i}` },
        });
        return (await response.json()).requestId;
      }),
    );

    assert.equal(new Set(results).size, 10, 'частина відповідей поділила один id');
  });
});

describe('LoggingInterceptor міряє час', () => {
  it('пише рядок із маршрутом і мілісекундами', async () => {
    const lines: string[] = [];
    const restore = setLogSink((line) => lines.push(line));

    try {
      await (await fetch(`${base}/ctx/shallow`)).text();
    } finally {
      restore();
    }

    assert.equal(lines.length, 1);
    // Той самий формат, що вимагає AC: grep -E "[0-9]+(\.[0-9]+)? ?ms"
    assert.match(lines[0], /GET \/ctx\/shallow/);
    assert.match(lines[0], /[0-9]+(\.[0-9]+)? ?ms/);
  });

  it('у рядок лога потрапляє requestId зі сховища', async () => {
    const lines: string[] = [];
    const restore = setLogSink((line) => lines.push(line));

    try {
      await (await fetch(`${base}/ctx/shallow`, {
        headers: { 'x-request-id': 'log-trace' },
      })).text();
    } finally {
      restore();
    }

    // Interceptor не отримує id аргументом — читає зі сховища, як і сервіси.
    assert.match(lines[0], /log-trace/);
  });

  it('логує навіть запит, що впав', async () => {
    const lines: string[] = [];
    const restore = setLogSink((line) => lines.push(line));

    try {
      await (await fetch(`${base}/ctx/deep/ok`)).text();
    } finally {
      restore();
    }

    assert.equal(lines.length, 1);
  });
});
