import { Injectable } from '@nestjs/common';

/**
 * Стан процесу, який читає readinessProbe (#28). Один екземпляр на процес.
 *
 * Два прапорці, бо «не готовий» має дві різні причини:
 *   warm      — прогрів скінчився: слухач стоїть і перше зʼєднання з БД вдалося;
 *   draining  — прийшов SIGTERM: процес ще живий і дороблює запити, але нових
 *               уже не хоче.
 *
 * Liveness (`GET /health`) цей стан не читає взагалі. Процес, що дренажить,
 * живий — і вбивати його посеред дренажу означало б обірвати ті самі запити,
 * заради яких дренаж існує.
 */
@Injectable()
export class Lifecycle {
  private warm = false;
  private draining = false;

  markWarm(): void {
    this.warm = true;
  }

  startDraining(): void {
    this.draining = true;
  }

  get isDraining(): boolean {
    return this.draining;
  }

  get ready(): boolean {
    return this.warm && !this.draining;
  }
}
