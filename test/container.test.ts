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
