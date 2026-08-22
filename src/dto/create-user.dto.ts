import { IsEmail, IsInt, IsString, Min, MinLength } from 'class-validator';

/**
 * Контракт тіла `POST /users`.
 *
 * DTO — саме КЛАС, а не інтерфейс, і це не стилістика. Інтерфейс зникає при
 * компіляції: у рантаймі не лишається ні полів, ні правил, ні самого імені.
 * Клас переживає компіляцію, тож на його властивості можна повісити декоратори,
 * а сам клас — записати в `design:paramtypes` хендлера. Диспетчер потім читає
 * звідти, ЯКИЙ клас створювати з тіла запиту.
 *
 * `!` після імені поля — це definite assignment assertion. Вона потрібна через
 * `strictPropertyInitialization`: компілятор бачить поле без ініціалізатора й
 * без присвоєння в конструкторі і справедливо лається. Ми ж знаємо, що поле
 * заповнить `plainToInstance`, тобто вже після виклику конструктора.
 */
export class CreateUserDto {
  @IsString()
  @MinLength(2)
  name!: string;

  @IsEmail()
  email!: string;

  @IsInt()
  @Min(16)
  age!: number;
}
