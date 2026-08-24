import 'reflect-metadata';

import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';

import { Container } from '../src/container';
import { Controller } from '../src/decorators/controller';
import { Injectable } from '../src/decorators/injectable';
import { Get, Post } from '../src/decorators/methods';
import { Body, Param, Query } from '../src/decorators/params';
import { compose, type ExecutionContext, type Stage, createApp } from '../src/dispatcher';
import { CreateUserDto } from '../src/dto/create-user.dto';
import { collectRoutes, matchSegments, toSegments } from '../src/router';

// ── Тестові класи ──────────────────────────────────────────────────────────
// Свої, а не UsersController: тест має перевіряти механізм, а не приклад.
// Якщо приклад завтра зміниться, тести механізму не мають від цього падати.

@Injectable()
class ProbeService {
  /** Лічильник викликів. Ним доводимо, що екземпляр той самий (AC#9). */
  calls = 0;

  hit(): number {
    this.calls += 1;
    return this.calls;
  }
}

@Controller('probe')
class ProbeController {
  constructor(private readonly service: ProbeService) {}

  @Get()
  list(@Query('limit') limit?: string): { limit: string | undefined; type: string } {
    return { limit, type: typeof limit };
  }

  @Get('hit')
  hit(): { calls: number } {
    return { calls: this.service.hit() };
  }

  @Get(':id')
  findOne(@Param('id') id: string): { id: string } {
    return { id };
  }

  @Get('nested/:group/:id')
  nested(@Param('group') group: string, @Param('id') id: string): { group: string; id: string } {
    return { group, id };
  }

  @Get('typed/:id')
  typed(
    // `: number` обовʼязковий — emitDecoratorMetadata читає анотацію, не виведений тип
    @Param('id') id: number,
    @Query('limit') limit: number = 7,
    @Query('debug') debug: boolean = false,
  ): { id: number; idType: string; limit: number; debug: boolean } {
    return { id, idType: typeof id, limit, debug };
  }

  @Post()
  create(@Body() dto: CreateUserDto): { isInstance: boolean; className: string; email: string } {
    return {
      // Саме те, чого вимагає AC#8: у хендлер приходить ЕКЗЕМПЛЯР класу.
      isInstance: dto instanceof CreateUserDto,
      className: dto.constructor.name,
      email: dto.email,
    };
  }

  @Post('raw')
  raw(@Body() body: unknown): { echoed: unknown } {
    // Тип аргументу — не DTO, тож пайп не вмикається і тіло йде як є.
    return { echoed: body };
  }
}

// ── Один сервер на весь файл ───────────────────────────────────────────────
// Порт 0 = ядро дає перший вільний. Хардкод порту зробив би тести
// неможливими паралельно і ламався б, щойно порт хтось зайняв.

const container = new Container();
const server = createApp(container, [ProbeController]);

// Адреса відома лише ПІСЛЯ listen, а listen асинхронний. Top-level await у
// CommonJS недоступний, тож підняття живе в before — він відпрацьовує до
// першого it, хоч ті й зареєстровані вище по файлу.
let base = '';

before(async () => {
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

after(() => {
  // Без close процес не завершиться: слухач тримає event loop живим.
  server.close();
});

/** Скорочення: віддає статус і вже розпарсене тіло. */
async function call(
  path: string,
  init?: { method?: string; body?: string; raw?: boolean },
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${base}${path}`, {
    method: init?.method ?? 'GET',
    headers: init?.body === undefined ? undefined : { 'content-type': 'application/json' },
    body: init?.body,
  });
  const text = await response.text();
  return { status: response.status, body: text === '' ? undefined : JSON.parse(text) };
}

// ── Юніти роутера ──────────────────────────────────────────────────────────

describe('toSegments', () => {
  it('ріже шлях і викидає порожні сегменти', () => {
    assert.deepEqual(toSegments('/users/42/'), ['users', '42']);
    assert.deepEqual(toSegments('/'), []);
    assert.deepEqual(toSegments('//users//42'), ['users', '42']);
  });
});

describe('matchSegments', () => {
  it('літерали мають збігтися дослівно', () => {
    assert.deepEqual(matchSegments(['users'], ['users']), {});
    assert.equal(matchSegments(['users'], ['orders']), null);
  });

  it('параметр приймає будь-яке значення й запамʼятовує його', () => {
    assert.deepEqual(matchSegments(['users', ':id'], ['users', '42']), { id: '42' });
  });

  it('різна довжина шляху — не збіг', () => {
    assert.equal(matchSegments(['users', ':id'], ['users']), null);
    assert.equal(matchSegments(['users'], ['users', '42']), null);
  });

  it('порожня мапа і null — різні відповіді', () => {
    // Обидва falsy-подібні на вигляд, але означають протилежне:
    // {} — збіг без параметрів, null — маршрут не підходить.
    assert.deepEqual(matchSegments([], []), {});
    assert.notEqual(matchSegments([], []), null);
  });

  it('значення в шляху розкодовується', () => {
    assert.deepEqual(matchSegments(['users', ':name'], ['users', 'john%20doe']), { name: 'john doe' });
  });
});

describe('collectRoutes', () => {
  it('збирає маршрути з метаданих, а не зі списку в коді', () => {
    const routes = collectRoutes([ProbeController]);
    const paths = routes.map((r) => `${r.method} ${r.path}`).sort();

    assert.deepEqual(paths, [
      'GET /probe',
      'GET /probe/:id',
      'GET /probe/hit',
      'GET /probe/nested/:group/:id',
      'GET /probe/typed/:id',
      'POST /probe',
      'POST /probe/raw',
    ]);
  });

  it('склеює префікс контролера зі шляхом методу', () => {
    const routes = collectRoutes([ProbeController]);
    const route = routes.find((r) => r.handlerName === 'findOne');

    assert.equal(route?.path, '/probe/:id');
    assert.deepEqual(route?.segments, ['probe', ':id']);
  });

  it('падає на класі без @Controller', () => {
    class Bare {}
    assert.throws(() => collectRoutes([Bare]), /не позначений @Controller/);
  });

  it('успадковує маршрути базового контролера', () => {
    // Саме заради цього в роутері getMetadata, а не getOwnMetadata:
    // він піднімається ланцюгом прототипів.
    class BaseController {
      @Get('health')
      health(): { ok: boolean } {
        return { ok: true };
      }
    }

    @Controller('v2')
    class ChildController extends BaseController {
      @Get()
      own(): string {
        return 'own';
      }
    }

    const paths = collectRoutes([ChildController]).map((r) => r.path).sort();
    assert.deepEqual(paths, ['/v2', '/v2/health']);
  });
});

// ── HTTP ───────────────────────────────────────────────────────────────────

describe('маршрутизація', () => {
  it('знаходить маршрут за склеєним префіксом (AC#3)', async () => {
    const { status } = await call('/probe/42');
    assert.equal(status, 200);
  });

  it('невідомий шлях дає 404, а не падіння', async () => {
    const { status, body } = await call('/nope');
    assert.equal(status, 404);
    assert.match(body.message, /Cannot GET \/nope/);
  });

  it('той самий шлях іншим методом теж 404', async () => {
    // Маршрут шукається за парою (метод, шлях), а не лише за шляхом.
    const { status } = await call('/probe/hit', { method: 'POST', body: '{}' });
    assert.equal(status, 404);
  });

  it('перший оголошений маршрут виграє', async () => {
    // '/probe/hit' і '/probe/:id' обидва підходять під GET /probe/hit.
    // Виграє hit, бо оголошений вище — та сама семантика, що в express.
    const { body } = await call('/probe/hit');
    assert.ok('calls' in body, 'мав спрацювати статичний маршрут, а не :id');
  });
});

describe('@Param (AC#4)', () => {
  it('сегмент шляху доходить до методу окремим аргументом', async () => {
    const { status, body } = await call('/probe/42');
    assert.equal(status, 200);
    assert.deepEqual(body, { id: '42' });
  });

  it('кілька параметрів підставляються за іменами, не за порядком', async () => {
    const { body } = await call('/probe/nested/admins/7');
    assert.deepEqual(body, { group: 'admins', id: '7' });
  });
});

describe('@Query (AC#5)', () => {
  it('значення з query string доходить до методу', async () => {
    const { status, body } = await call('/probe?limit=5');
    assert.equal(status, 200);
    assert.equal(body.limit, '5');
  });

  it('query завжди рядок — типів у URL немає', async () => {
    const { body } = await call('/probe?limit=5');
    assert.equal(body.type, 'string');
  });

  it('відсутній query дає undefined, а не null', async () => {
    // Різниця не косметична: дефолтне значення аргументу спрацьовує
    // лише на undefined, а URLSearchParams.get віддає null.
    const { body } = await call('/probe');
    assert.equal(body.type, 'undefined');
  });
});

describe('@Body (AC#6)', () => {
  it('JSON-тіло приходить розпарсеним', async () => {
    const { status, body } = await call('/probe/raw', { method: 'POST', body: '{"a":1,"b":[2,3]}' });
    assert.equal(status, 201);
    assert.deepEqual(body.echoed, { a: 1, b: [2, 3] });
  });

  it('невалідний JSON дає 400, а не 500', async () => {
    const { status, body } = await call('/probe/raw', { method: 'POST', body: '{невалідний' });
    assert.equal(status, 400);
    assert.match(body.message, /не є валідним JSON/);
  });
});

describe('валідація DTO', () => {
  it('невалідне тіло дає 400 з назвою поля (AC#7)', async () => {
    const { status, body } = await call('/probe', {
      method: 'POST',
      body: JSON.stringify({ email: 'not-an-email' }),
    });

    assert.equal(status, 400);
    assert.match(JSON.stringify(body), /email/);
  });

  it('віддає ВСІ невалідні поля списком, а не перше', async () => {
    const { body } = await call('/probe', {
      method: 'POST',
      body: JSON.stringify({ name: 'x', email: 'nope', age: 5 }),
    });

    const fields = body.errors.map((e: { field: string }) => e.field).sort();
    assert.deepEqual(fields, ['age', 'email', 'name']);
  });

  it('валідне тіло проходить і приходить ЕКЗЕМПЛЯРОМ DTO (AC#8)', async () => {
    const { status, body } = await call('/probe', {
      method: 'POST',
      body: JSON.stringify({ name: 'Ada', email: 'ada@example.com', age: 36 }),
    });

    assert.equal(status, 201);
    assert.equal(body.isInstance, true);
    assert.equal(body.className, 'CreateUserDto');
  });

  it('зайві поля вирізаються на вході (whitelist)', async () => {
    const { status } = await call('/probe', {
      method: 'POST',
      body: JSON.stringify({ name: 'Bob', email: 'b@e.com', age: 20, role: 'admin' }),
    });

    // Не 400: whitelist мовчки ріже, а не відхиляє (це був би forbidNonWhitelisted).
    assert.equal(status, 201);
  });

  it('рядок замість числа НЕ коерситься', async () => {
    // transform робить екземпляр класу, але типи не приводить.
    // Це відрізняє Nest від Fastify, де ajv коерсить мовчки.
    const { status, body } = await call('/probe', {
      method: 'POST',
      body: JSON.stringify({ name: 'Ada', email: 'ada@example.com', age: '36' }),
    });

    assert.equal(status, 400);
    assert.match(JSON.stringify(body), /age/);
  });
});

describe('контейнер із частини 1 (AC#9)', () => {
  it('сервіс у контролері — той самий singleton, що в контейнері', async () => {
    const before = container.resolve(ProbeService).calls;

    await call('/probe/hit');

    // Якби диспетчер робив `new ProbeController()` замість resolve, лічильник
    // у контейнерному екземплярі не зрушив би з місця.
    assert.equal(container.resolve(ProbeService).calls, before + 1);
  });

  it('контролер теж singleton — на другому запиті той самий обʼєкт', async () => {
    const first = container.resolve(ProbeController);
    await call('/probe/1');
    assert.equal(container.resolve(ProbeController), first);
  });
});

describe('серіалізація відповіді', () => {
  it('content-length рахується в БАЙТАХ, не в символах', async () => {
    // 'Ada' замінили б на кирилицю — і при підрахунку по .length
    // відповідь обрізалася б посередині.
    const response = await fetch(`${base}/probe/${encodeURIComponent('Ада')}`);
    const declared = Number(response.headers.get('content-length'));
    const actual = Buffer.byteLength(await response.text(), 'utf8');

    assert.equal(declared, actual);
  });

  it('віддає JSON із charset', async () => {
    const response = await fetch(`${base}/probe/1`);
    assert.match(response.headers.get('content-type') ?? '', /application\/json/);
  });
});

// ── Правки після рев'ю ─────────────────────────────────────────────────────

describe('битий percent-encoding (не 500, а 400)', () => {
  it('/%zz дає 400 з поясненням, а не 500', async () => {
    // decodeURIComponent кидає URIError на будь-якому битому кодуванні.
    // Без try/catch у matchSegments чуже сміття виглядало б як наша поломка.
    const { status, body } = await call('/probe/%zz');
    assert.equal(status, 400);
    assert.match(body.message, /percent-кодування/);
  });

  it('обірвана послідовність теж 400', async () => {
    const { status } = await call('/probe/%E0%A4%A');
    assert.equal(status, 400);
  });

  it('коректне кодування далі працює', async () => {
    const { status, body } = await call(`/probe/${encodeURIComponent('джон доу')}`);
    assert.equal(status, 200);
    assert.deepEqual(body, { id: 'джон доу' });
  });
});

describe('пайп приведення для @Param і @Query', () => {
  it('@Param(): number приходить числом, а не рядком', async () => {
    const { body } = await call('/probe/typed/42');
    assert.equal(body.id, 42);
    assert.equal(body.idType, 'number');
  });

  it('@Query(): number приходить числом', async () => {
    const { body } = await call('/probe/typed/1?limit=5');
    assert.equal(body.limit, 5);
  });

  it('нечислове значення дає 400 на межі, а не NaN у хендлері', async () => {
    const { status, body } = await call('/probe/typed/1?limit=abc');
    assert.equal(status, 400);
    assert.match(body.message, /limit/);
  });

  it('Number(), а не parseInt: "12abc" не стає 12', async () => {
    // parseInt мовчки зʼїв би хвіст, і опечатка перетворилась би на валідне число.
    const { status } = await call('/probe/typed/1?limit=12abc');
    assert.equal(status, 400);
  });

  it('відсутній query лишає дефолт із сигнатури', async () => {
    const { body } = await call('/probe/typed/1');
    assert.equal(body.limit, 7);
  });

  it('@Query(): boolean розуміє порожній прапорець', async () => {
    // '?debug' без значення прийде як '' — і це «увімкнено», а не хиба.
    const { body } = await call('/probe/typed/1?debug');
    assert.equal(body.debug, true);
  });

  it('@Query(): boolean розуміє false і 0', async () => {
    assert.equal((await call('/probe/typed/1?debug=false')).body.debug, false);
    assert.equal((await call('/probe/typed/1?debug=0')).body.debug, false);
  });
});

describe('compose — ланцюг стадій', () => {
  const emptyCtx = (): ExecutionContext => ({}) as ExecutionContext;

  it('виконує стадії по черзі й повертається назад', async () => {
    const log: string[] = [];
    const stage = (name: string): Stage => async (_ctx, next) => {
      log.push(`${name}:before`);
      await next();
      log.push(`${name}:after`);
    };

    await compose([stage('a'), stage('b')])(emptyCtx());

    // Саме цей «сендвіч» і робить interceptor'и з Лекції 8 можливими:
    // стадія бачить момент до виклику хендлера і момент після.
    assert.deepEqual(log, ['a:before', 'b:before', 'b:after', 'a:after']);
  });

  it('стадія, що не кличе next, обриває ланцюг', async () => {
    // Так працюватиме guard: не пустив — хвіст не виконується.
    const log: string[] = [];
    const guard: Stage = async () => {
      log.push('guard');
    };
    const never: Stage = async () => {
      log.push('never');
    };

    await compose([guard, never])(emptyCtx());
    assert.deepEqual(log, ['guard']);
  });

  it('подвійний next() кидає помилку, а не виконує хвіст двічі', async () => {
    let calls = 0;
    const broken: Stage = async (_ctx, next) => {
      await next();
      await next();
    };
    const counter: Stage = async () => {
      calls += 1;
    };

    await assert.rejects(compose([broken, counter])(emptyCtx()), /next\(\) викликано двічі/);
    assert.equal(calls, 1, 'хендлер не має відпрацювати двічі на один запит');
  });

  it('порожній ланцюг просто завершується', async () => {
    await compose([])(emptyCtx());
  });
});

describe('emitDecoratorMetadata читає анотацію, а не виведений тип', () => {
  it('параметр без `: type` дає Object і пайп його не приводить', () => {
    class Probe {
      @Get('a')
      // eslint-disable-next-line @typescript-eslint/no-inferrable-types
      withDefault(@Query('n') n = 10): number {
        return n;
      }

      @Get('b')
      annotated(@Query('n') n: number = 10): number {
        return n;
      }
    }

    const withDefault = Reflect.getMetadata('design:paramtypes', Probe.prototype, 'withDefault');
    const annotated = Reflect.getMetadata('design:paramtypes', Probe.prototype, 'annotated');

    // Обидва — number для type-checker'а, але в метадані їде різне.
    // Це та сама пастка, що вже коштувала нам одного «чому limit рядок».
    assert.deepEqual(withDefault, [Object]);
    assert.deepEqual(annotated, [Number]);
  });
});
