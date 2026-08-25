import { getRequestId } from '../context/request-context';
import { Controller } from '../decorators/controller';
import { Get, Post } from '../decorators/methods';
import { Body, Param, Query } from '../decorators/params';
import { UseGuards, UseInterceptors } from '../decorators/use-guards';
import type { CreateUserDto } from '../dto/create-user.dto';
import { createUserSchema } from '../dto/create-user.dto';
import { NotFoundError } from '../errors';
import { AuthGuard } from '../guards/auth.guard';
import { LoggingInterceptor } from '../interceptors/logging.interceptor';
import type { User } from '../services/users.service';
import { UsersService } from '../services/users.service';

/**
 * Interceptor на КЛАСІ — міряє тривалість усіх маршрутів контролера.
 * Guard навмисно НЕ тут: читання лишається публічним, захищаємо лише запис.
 */
@Controller('users')
@UseInterceptors(LoggingInterceptor)
export class UsersController {
  constructor(private readonly users: UsersService) {}

  /** `GET /users?limit=5` — значення прилітає окремим аргументом, уже числом. */
  @Get()
  list(@Query('limit') limit: number = 10): { limit: number; items: User[] } {
    return { limit, items: this.users.findAll(limit) };
  }

  /**
   * Маршрут для перевірки exception filter'а на НЕОЧІКУВАНІЙ помилці.
   * Оголошений вище за `:id`, інакше 'boom' зматчився б як id.
   */
  @Get('boom')
  boom(): never {
    // Звичайний Error, не HttpError — фільтр має віддати рівне 500
    // і не пустити назовні ні текст, ні стек.
    throw new Error('boom');
  }

  /** Показує, що requestId доступний і в обробнику — без жодного аргументу. */
  @Get('whoami')
  whoami(): { requestId: string | undefined } {
    return { requestId: getRequestId() };
  }

  /** `GET /users/42` — доменна помилка мапиться у 404 з поясненням. */
  @Get(':id')
  findOne(@Param('id') id: string): User {
    const user = this.users.findOne(id);

    if (user === undefined) {
      // Кидаємо доменну помилку, а не формуємо відповідь: обробник не має
      // знати про HTTP-статуси. Перекласти її в 404 — робота filter'а.
      throw new NotFoundError(`Користувача ${id} не знайдено`);
    }

    return user;
  }

  /**
   * `POST /users` — тут повний цикл видно найкраще.
   *
   * Guard стоїть на МЕТОДІ: захищаємо запис, лишаючи читання відкритим.
   * Схема передана значенням у `@Body()` — Zod-схема не є типом, тож у
   * `design:paramtypes` вона потрапити не може в принципі.
   */
  @Post()
  @UseGuards(AuthGuard)
  create(@Body(createUserSchema) dto: CreateUserDto): { created: User; requestId: string | undefined } {
    return { created: this.users.create(dto), requestId: getRequestId() };
  }
}
