import { Controller } from '../decorators/controller';
import { Get, Post } from '../decorators/methods';
import { Body, Param, Query } from '../decorators/params';
import { CreateUserDto } from '../dto/create-user.dto';
import type { User } from './users.service';
import { UsersService } from './users.service';

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
  constructor(private readonly users: UsersService) {}

  /** `GET /users?limit=5` — значення прилітає окремим аргументом. */
  @Get()
  list(@Query('limit') limit?: string): { limit: number; items: User[] } {
    // Query завжди рядок: у URL типів немає. Приведення — робота хендлера,
    // якщо він її не попросив у пайпа.
    const parsed = Number.parseInt(limit ?? '10', 10);
    const safeLimit = Number.isNaN(parsed) ? 10 : parsed;
    return { limit: safeLimit, items: this.users.findAll(safeLimit) };
  }

  /** `GET /users/42` — сегмент шляху як аргумент. */
  @Get(':id')
  findOne(@Param('id') id: string): { id: string; found: User | null } {
    return { id, found: this.users.findOne(id) ?? null };
  }

  /** `POST /users` — тіло приходить ЕКЗЕМПЛЯРОМ CreateUserDto, уже перевіреним. */
  @Post()
  create(@Body() dto: CreateUserDto): { created: User; dtoClass: string } {
    return { created: this.users.create(dto), dtoClass: dto.constructor.name };
  }
}
