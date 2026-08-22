import { Injectable } from '../decorators/injectable';
import type { CreateUserDto } from '../dto/create-user.dto';

export interface User {
  id: string;
  name: string;
  email: string;
  age: number;
}

/**
 * Сховище в памʼяті. Бази тут немає — вона зʼявиться на Лекції 12.
 *
 * Скоуп singleton (дефолт контейнера), тож `users` живе стільки ж, скільки
 * процес. На фронті так поводився б модуль зі змінною на верхньому рівні —
 * різниця в тому, що тут його бачать УСІ клієнти одночасно, а не одна вкладка.
 */
@Injectable()
export class UsersService {
  private readonly users = new Map<string, User>();
  private nextId = 1;

  findOne(id: string): User | undefined {
    return this.users.get(id);
  }

  findAll(limit: number): User[] {
    return [...this.users.values()].slice(0, limit);
  }

  create(dto: CreateUserDto): User {
    const user: User = { id: String(this.nextId), ...dto };
    this.nextId += 1;
    this.users.set(user.id, user);
    return user;
  }
}
