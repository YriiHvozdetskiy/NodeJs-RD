import { Injectable } from '../decorators/injectable';
import type { CreateUserDto } from '../dto/create-user.dto';
import { AuditService } from './audit.service';

export interface User {
  id: string;
  name: string;
  email: string;
  age: number;
}

/**
 * Проміжний рівень: обробник кличе його, він кличе AuditService.
 *
 * Сам по собі про контекст запиту не знає нічого й не має знати — саме тому
 * в жодному його методі немає зайвого аргументу. Контекст їде «повз» нього
 * у сховищі, а не крізь нього в сигнатурах.
 *
 * Скоуп singleton (дефолт), тож `users` живе стільки ж, скільки процес.
 * На фронті так поводився б модуль зі змінною на верхньому рівні — різниця
 * в тому, що тут його бачать УСІ клієнти одночасно, а не одна вкладка.
 */
@Injectable()
export class UsersService {
  private readonly users = new Map<string, User>();
  private nextId = 1;

  constructor(private readonly audit: AuditService) {}

  findOne(id: string): User | undefined {
    this.audit.record(`users.findOne:${id}`);
    return this.users.get(id);
  }

  findAll(limit: number): User[] {
    this.audit.record(`users.findAll:${limit}`);
    return [...this.users.values()].slice(0, limit);
  }

  create(dto: CreateUserDto): User {
    const user: User = { id: String(this.nextId), ...dto };
    this.nextId += 1;
    this.users.set(user.id, user);
    this.audit.record(`users.create:${user.id}`);
    return user;
  }
}
