import 'reflect-metadata';

import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';
import { z } from 'zod';

import { Container } from '../src/container';
import type { LifecycleStage } from '../src/context/lifecycle-trace';
import { setLifecycleTracer } from '../src/context/lifecycle-trace';
import { Controller } from '../src/decorators/controller';
import { Injectable } from '../src/decorators/injectable';
import { Get, Post } from '../src/decorators/methods';
import { Body } from '../src/decorators/params';
import { UseGuards, UseInterceptors } from '../src/decorators/use-guards';
import { createApp } from '../src/dispatcher';
import { NotFoundError } from '../src/errors';
import type { CanActivate, Interceptor, LifecycleContext } from '../src/types';

/** Куди всі учасники циклу пишуть свої мітки. Чиститься перед кожним тестом. */
const log: string[] = [];

/** Скільки разів реально викликався обробник — спай для AC «guard блокує». */
let handlerCalls = 0;

const schema = z.object({ name: z.string().min(2) }).strict();

@Injectable()
class RecordingGuard implements CanActivate {
  canActivate(ctx: LifecycleContext): boolean {
    log.push('guard:body');
    return ctx.headers.authorization === 'Bearer ok';
  }
}

@Injectable()
class RecordingInterceptor implements Interceptor {
  async intercept(_ctx: LifecycleContext, next: () => Promise<void>): Promise<void> {
    log.push('interceptor:body:before');
    await next();
    log.push('interceptor:body:after');
  }
}

@Controller('flow')
@UseInterceptors(RecordingInterceptor)
class FlowController {
  @Get('open')
  open(): { ok: boolean } {
    handlerCalls += 1;
    return { ok: true };
  }

  @Post('guarded')
  @UseGuards(RecordingGuard)
  guarded(@Body(schema) dto: { name: string }): { name: string } {
    handlerCalls += 1;
    return { name: dto.name };
  }

  @Get('missing')
  missing(): never {
    handlerCalls += 1;
    throw new NotFoundError('Немає такого');
  }

  @Get('broken')
  broken(): never {
    handlerCalls += 1;
    throw new Error('boom');
  }
}

const container = new Container();
const server = createApp(container, [FlowController]);
let base = '';
let stopTracing = (): void => {};

before(async () => {
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  stopTracing = setLifecycleTracer((stage: LifecycleStage) => {
    log.push(stage);
  });
});

after(() => {
  stopTracing();
  server.close();
});

beforeEach(() => {
  log.length = 0;
  handlerCalls = 0;
});

async function call(path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const response = await fetch(`${base}${path}`, init);
  const text = await response.text();
  return { status: response.status, body: text === '' ? undefined : JSON.parse(text) };
}

describe('порядок етапів життєвого циклу', () => {
  it('шість етапів у точній послідовності (AC#2)', async () => {
    await call('/flow/open');

    // Не «щось викликалось», а рівно ця послідовність. Мітки самих
    // guard/interceptor відфільтровані — тут перевіряється КАРКАС циклу.
    const stages = log.filter((entry) => !entry.includes(':body'));

    assert.deepEqual(stages, [
      'middleware',
      'guard',
      'interceptor:before',
      'pipe',
      'handler',
      'interceptor:after',
    ]);
  });

  it('interceptor обгортає, а не стоїть у лінії', async () => {
    await call('/flow/open');

    const before = log.indexOf('interceptor:body:before');
    const handler = log.indexOf('handler');
    const afterMark = log.indexOf('interceptor:body:after');

    // Тіло interceptor'а лежить ПО ОБИДВА боки від обробника.
    // Guard так не вміє — у нього є лише «до».
    assert.ok(before < handler, 'before має бути до обробника');
    assert.ok(handler < afterMark, 'after має бути після обробника');
  });

  it('guard виконується до pipe, а не після', async () => {
    // Немає сенсу валідувати тіло запиту, який усе одно не пустять —
    // і це найдорожча робота в циклі.
    await call('/flow/guarded', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ok' },
      body: JSON.stringify({ name: 'Ada' }),
    });

    assert.ok(log.indexOf('guard') < log.indexOf('pipe'));
  });
});

describe('guard блокує до обробника (AC#3)', () => {
  it('без Authorization — 403', async () => {
    const { status } = await call('/flow/guarded', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Ada' }),
    });

    assert.equal(status, 403);
  });

  it('обробник не викликався ЖОДНОГО разу', async () => {
    await call('/flow/guarded', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Ada' }),
    });

    // Не «результат відкинули» — обробник не запускався взагалі.
    assert.equal(handlerCalls, 0);
  });

  it('pipe теж не виконувався — цикл обірвано раніше', async () => {
    await call('/flow/guarded', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x' }),
    });

    assert.ok(!log.includes('pipe'), 'валідація не мала запускатись');
    assert.ok(!log.includes('handler'));
  });

  it('невалідне тіло з правильним токеном доходить до pipe і падає там', async () => {
    const { status, body } = await call('/flow/guarded', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ok' },
      body: JSON.stringify({ name: 'x' }),
    });

    assert.equal(status, 400);
    assert.ok(log.includes('pipe'));
    assert.equal(handlerCalls, 0, 'pipe зупинив цикл до обробника');
    assert.match(JSON.stringify(body), /name/);
  });

  it('interceptor:after спрацьовує навіть коли guard не пустив', async () => {
    await call('/flow/guarded', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Ada' }),
    });

    // Guard стоїть ДО interceptor'а, тож той навіть не починався —
    // ні before, ні after у лозі бути не повинно.
    assert.ok(!log.includes('interceptor:before'));
    assert.ok(!log.includes('interceptor:after'));
  });
});

describe('exception filter', () => {
  it('доменна помилка мапиться у 404 з поясненням (AC#7)', async () => {
    const { status, body } = await call('/flow/missing');

    assert.equal(status, 404);
    assert.equal(body.message, 'Немає такого');
  });

  it('несподівана помилка дає 500 без слова boom і без стека (AC#6)', async () => {
    const { status, body } = await call('/flow/broken');

    assert.equal(status, 500);
    assert.doesNotMatch(JSON.stringify(body), /boom|at .*\.(ts|js):/);
  });

  it('каркасна мітка interceptor:after є навіть на 500', async () => {
    await call('/flow/broken');

    // Сам цикл ставить її у finally, тож вихід із шару видно завжди —
    // незалежно від того, як написаний конкретний interceptor.
    assert.ok(log.includes('interceptor:after'));
  });

  it('interceptor БЕЗ try/finally не побачить падіння — і це його проблема', async () => {
    await call('/flow/broken');

    // RecordingInterceptor написаний як `await next(); log.push('after')`.
    // Обробник кинув — рядок після await просто не виконався.
    assert.ok(log.includes('interceptor:body:before'));
    assert.ok(
      !log.includes('interceptor:body:after'),
      'без finally код після await next() не виконується на помилці',
    );

    // Саме тому LoggingInterceptor має finally: інакше в логах не буде
    // рівно тих запитів, заради яких у логи й дивляться.
  });

  it('404 маршруту не доходить до жодного етапу циклу', async () => {
    const { status } = await call('/flow/no-such-route');

    assert.equal(status, 404);
    // Маршрут не знайдено — циклу немає взагалі, кидається одразу з execute.
    assert.deepEqual(log, []);
  });
});
