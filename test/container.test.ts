// reflect-metadata — НАЙПЕРШИМ рядком. Це поліфіл сховища метаданих:
// без нього Reflect.getMetadata просто не існує, і падіння виглядало б як
// «getMetadata is not a function», а не як проблема з DI.
import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { CircularDependencyError, Container } from '../src/container';
import { Inject } from '../src/decorators/inject';
import { Injectable } from '../src/decorators/injectable';
import { forwardRef } from '../src/forward-ref';
import { CONFIG } from '../src/tokens';

describe('Container', () => {
  describe('резолв графа за design:paramtypes', () => {
    @Injectable() class C { readonly tag = 'C'; }
    @Injectable() class B { constructor(readonly c: C) {} }
    @Injectable() class A { constructor(readonly b: B) {} }

    test('A залежить від B, B від C — граф збирається рекурсивно', () => {
      const a = new Container().resolve(A);

      assert.ok(a instanceof A);
      assert.ok(a.b instanceof B, 'B має бути створений');
      assert.ok(a.b.c instanceof C, 'C має бути живим екземпляром усередині');
      assert.equal(a.b.c.tag, 'C');
    });

    test('клас без параметрів конструктора резолвиться (paramtypes = undefined)', () => {
      assert.ok(new Container().resolve(C) instanceof C);
    });
  });

  describe('скоупи', () => {
    @Injectable() class Default {}
    @Injectable({ scope: 'singleton' }) class Explicit {}
    @Injectable({ scope: 'transient' }) class Transient {}

    test('singleton за замовчуванням — той самий екземпляр', () => {
      const container = new Container();
      assert.equal(container.resolve(Default), container.resolve(Default));
    });

    test('явний singleton поводиться так само', () => {
      const container = new Container();
      assert.equal(container.resolve(Explicit), container.resolve(Explicit));
    });

    test('transient — новий екземпляр на кожен resolve', () => {
      const container = new Container();
      assert.notEqual(container.resolve(Transient), container.resolve(Transient));
    });

    test('singleton спільний між різними споживачами, не по одному на кожного', () => {
      @Injectable() class Shared {}
      @Injectable() class First { constructor(readonly s: Shared) {} }
      @Injectable() class Second { constructor(readonly s: Shared) {} }

      const container = new Container();
      assert.equal(container.resolve(First).s, container.resolve(Second).s);
    });

    test('різні контейнери не ділять синглтони', () => {
      assert.notEqual(new Container().resolve(Default), new Container().resolve(Default));
    });
  });

  describe('@Inject(token)', () => {
    interface AppConfig { url: string }
    const MAILER = Symbol.for('MAILER');
    interface Mailer { send(to: string): string }

    @Injectable() class Logger { log(m: string) { return `[log] ${m}`; } }

    @Injectable()
    class UserService {
      constructor(
        readonly logger: Logger,
        @Inject(CONFIG) readonly config: AppConfig,
        @Inject(MAILER) readonly mailer: Mailer,
      ) {}
    }

    test('залежність під Symbol.for(CONFIG) резолвиться за токеном, а не за типом', () => {
      const container = new Container();
      container.register<AppConfig>(CONFIG, { url: 'postgres://localhost' });
      container.register<Mailer>(MAILER, { send: (to) => `лист до ${to}` });

      const service = container.resolve(UserService);

      // за типом — компілятор поклав Logger у design:paramtypes
      assert.ok(service.logger instanceof Logger);
      // за токеном — тип у метаданих був Object, інформації в ньому нуль
      assert.equal(service.config.url, 'postgres://localhost');
      assert.equal(service.mailer.send('a@b.c'), 'лист до a@b.c');
    });

    test('токен перекриває позицію, не зсуваючи арність конструктора', () => {
      assert.equal(UserService.length, 3);
    });

    test('register віддає те саме значення, а не копію', () => {
      const config = { url: 'x' };
      const container = new Container();
      container.register<AppConfig>(CONFIG, config);

      assert.equal(container.resolve<AppConfig>(CONFIG), config);
    });
  });

  describe('детекція циклічних залежностей', () => {
    interface IB { ping(): string }

    // A посилається на B через forwardRef: без тунка модуль впав би з
    // ReferenceError: Cannot access 'B' before initialization — компілятор
    // емітить design:paramtypes одразу за оголошенням A, коли B ще в TDZ.
    @Injectable() class A { constructor(@Inject(forwardRef(() => B)) readonly b: IB) {} }
    @Injectable() class B { constructor(readonly a: A) {} ping() { return 'pong'; } }

    test('A -> B -> A кидає помилку з повним ланцюгом, і це не RangeError', () => {
      assert.throws(
        () => new Container().resolve(A),
        (error: unknown) => {
          assert.ok(error instanceof CircularDependencyError);
          assert.ok(!(error instanceof RangeError), 'не має бути переповнення стека');
          assert.match(error.message, /A -> B -> A/);
          assert.deepEqual(error.chain, ['A', 'B', 'A']);
          return true;
        },
      );
    });

    test('самопосилання теж ловиться', () => {
      @Injectable() class Selfy { constructor(readonly self: Selfy) {} }

      assert.throws(
        () => new Container().resolve(Selfy),
        (error: unknown) => error instanceof CircularDependencyError
          && /Selfy -> Selfy/.test(error.message),
      );
    });

    test('здоровий глибокий граф не приймається за цикл', () => {
      @Injectable() class Leaf {}
      @Injectable() class Mid { constructor(readonly leaf: Leaf) {} }
      @Injectable() class Top { constructor(readonly mid: Mid) {} }

      assert.ok(new Container().resolve(Top).mid.leaf instanceof Leaf);
    });
  });

  describe('зрозумілі помилки', () => {
    test('клас без @Injectable() не резолвиться', () => {
      class Undecorated {}

      assert.throws(() => new Container().resolve(Undecorated), /не позначений @Injectable/);
    });

    test('нащадок не успадковує наліпку батька разом з чужими paramtypes', () => {
      @Injectable() class Parent {}
      class Child extends Parent {}

      assert.throws(() => new Container().resolve(Child), /Child не позначений @Injectable/);
    });

    test('незареєстрований symbol-токен дає внятну помилку, а не TypeError', () => {
      assert.throws(
        () => new Container().resolve(Symbol.for('НЕЗАРЕЄСТРОВАНИЙ')),
        /це не клас, і його не зареєстровано/,
      );
    });
  });
});

describe('правки після рев\'ю', () => {
  describe('path не в публічній сигнатурі', () => {
    test('resolve приймає рівно один аргумент — фальшивий цикл ізвні неможливий', () => {
      // resolve(Foo, [Foo]) давав би «Foo -> Foo» на здоровому графі.
      // Рекурсія переїхала в приватний resolveNode.
      assert.equal(Container.prototype.resolve.length, 1);
    });

    test('той самий токен у двох незалежних гілках графа не приймається за цикл', () => {
      @Injectable() class Shared {}
      @Injectable() class Left { constructor(readonly s: Shared) {} }
      @Injectable() class Right { constructor(readonly s: Shared) {} }
      @Injectable() class Root { constructor(readonly l: Left, readonly r: Right) {} }

      const root = new Container().resolve(Root);
      assert.equal(root.l.s, root.r.s, 'ромб має зійтися в один синглтон');
    });
  });

  describe('помилка називає шлях резолву', () => {
    const MISSING = Symbol.for('MISSING_DEP');

    @Injectable() class Deep { constructor(@Inject(MISSING) readonly missing: unknown) {} }
    @Injectable() class Mid { constructor(readonly deep: Deep) {} }
    @Injectable() class Top { constructor(readonly mid: Mid) {} }

    test('незареєстрований токен на глибині 3 — видно всіх, хто його просив', () => {
      assert.throws(
        () => new Container().resolve(Top),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /Top -> Mid -> Deep -> Symbol\(MISSING_DEP\)/);
          return true;
        },
      );
    });

    test('клас без @Injectable() на глибині теж показує шлях', () => {
      class Undecorated {}
      @Injectable() class Holder { constructor(readonly u: Undecorated) {} }

      assert.throws(() => new Container().resolve(Holder), /Шлях резолву: Holder -> Undecorated/);
    });
  });

  describe('registerClass — useClass', () => {
    interface Repo { find(): string }
    const USER_REPO = Symbol.for('USER_REPO');

    @Injectable() class PgUserRepo { find() { return 'pg'; } }
    @Injectable() class FakeUserRepo { find() { return 'fake'; } }
    @Injectable() class UserService { constructor(@Inject(USER_REPO) readonly repo: Repo) {} }

    test('токен прив\'язується до класу, і контейнер створює його сам', () => {
      const container = new Container();
      container.registerClass<Repo>(USER_REPO, PgUserRepo);

      const service = container.resolve(UserService);
      assert.ok(service.repo instanceof PgUserRepo, 'має бути ЕКЗЕМПЛЯР, не сам клас');
      assert.equal(service.repo.find(), 'pg');
    });

    test('той самий сервіс отримує фейк, якщо токен вказує на інший клас', () => {
      const container = new Container();
      container.registerClass<Repo>(USER_REPO, FakeUserRepo);

      assert.equal(container.resolve(UserService).repo.find(), 'fake');
    });

    test('аліас і клас віддають той самий синглтон', () => {
      const container = new Container();
      container.registerClass<Repo>(USER_REPO, PgUserRepo);

      assert.equal(container.resolve<Repo>(USER_REPO), container.resolve(PgUserRepo));
    });

    test('useValue має пріоритет над useClass для того самого токена', () => {
      const container = new Container();
      const stub: Repo = { find: () => 'stub' };
      container.registerClass<Repo>(USER_REPO, PgUserRepo);
      container.register<Repo>(USER_REPO, stub);

      assert.equal(container.resolve<Repo>(USER_REPO), stub);
    });

    test('цикл через аліас ловиться, і токен видно в ланцюгу', () => {
      const ALIAS_B = Symbol.for('ALIAS_B');

      @Injectable() class AliasA { constructor(@Inject(ALIAS_B) readonly b: unknown) {} }
      @Injectable() class AliasB { constructor(readonly a: AliasA) {} }

      const container = new Container();
      container.registerClass(ALIAS_B, AliasB);

      assert.throws(
        () => container.resolve(AliasA),
        (error: unknown) => {
          assert.ok(error instanceof CircularDependencyError);
          assert.deepEqual(error.chain, ['AliasA', 'Symbol(ALIAS_B)', 'AliasB', 'AliasA']);
          return true;
        },
      );
    });
  });
});
