import {Controller} from '../decorators/controller';
import {Get, Post} from '../decorators/methods';
import {Body, Param, Query} from '../decorators/params';
import {CreateUserDto} from '../dto/create-user.dto';
import type {User} from './users.service';
import {UsersService} from './users.service';

/**
 * Контролер знає рівно два способи спілкуватися зі світом: аргументи на вході
 * і повернене значення на виході. `req` і `res` він не бачить взагалі — і це
 * не обмеження, а сенс усієї конструкції: такий метод тестується прямим
 * викликом, без підняття сервера.
 *
 * Сервіс приходить через конструктор. `@Controller` уже поставив наліпку
 * INJECTABLE, тож контейнер із частини 1 прочитає `design:paramtypes`,
 * побачить там `UsersService` і зарезолвить його рекурсивно.
 */
@Controller('users')
export class UsersController {
   constructor(private readonly users: UsersService) {
   }

   /**
    * `GET /users?limit=5` — значення прилітає окремим аргументом, УЖЕ числом.
    *
    * `parseInt` тут немає навмисно. У URL типів не буває, тож приведення робить
    * пайп на межі запиту — він бачить `design:paramtypes` цього методу і знає,
    * що оголошено `number`. `?limit=abc` дасть 400 ще до входу сюди, а не
    * `NaN`, який поїде далі й зламається десь у сервісі.
    *
    * Дефолт живе там, де йому й місце — у сигнатурі. Пайп повертає `undefined`
    * на відсутнє значення саме для того, щоб дефолт спрацював.
    *
    * ⚠ `: number` тут ОБОВʼЯЗКОВИЙ, попри те що з `= 10` тип і так виводиться.
    * emitDecoratorMetadata дивиться на СИНТАКСИЧНУ анотацію, а не на виведений
    * тип: без неї в `design:paramtypes` їде `Object`, пайп не бачить, до чого
    * приводити, і значення тихо лишається рядком. Перевірено — саме так і було.
    */
   @Get()
   list(@Query('limit') limit: number = 10): { limit: number; items: User[] } {
      return {limit, items: this.users.findAll(limit)};
   }

   /** `GET /users/42` — сегмент шляху як аргумент. */
   @Get(':id')
   findOne(@Param('id') id: string): { id: string; found: User | null } {
      return {id, found: this.users.findOne(id) ?? null};
   }

   /** `POST /users` — тіло приходить ЕКЗЕМПЛЯРОМ CreateUserDto, уже перевіреним. */
   @Post()
   create(@Body() dto: CreateUserDto): { created: User; dtoClass: string } {
      return {created: this.users.create(dto), dtoClass: dto.constructor.name};
   }
}
