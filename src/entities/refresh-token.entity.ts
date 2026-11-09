import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique, type Relation } from 'typeorm';
import type { User } from './user.entity';

/**
 * Refresh-токен (#24). Сам токен — випадкові 32 байти в руках клієнта; у базі
 * лише `token_hash` = HMAC-SHA256(перець зі сховища, токен). Дамп таблиці від
 * цього не стає дампом чинних сесій: хеш назад у токен не обертається, а
 * перевірити здогадку без перцю нічим.
 *
 * Стан рядка — два моменти часу, а не enum:
 *   used_at    — токен обміняли на нову пару. Повторне предʼявлення =
 *                компрометація: відкликається вся сімʼя;
 *   revoked_at — сімʼю закрито: логаут або виявлений повтор.
 *
 * `family_id` — один логін: усі токени, що виросли з нього ротаціями.
 * `parent_id` — звʼязок «з якого токена виписано цей». Саме цей звʼязок
 * RFC 9700 §4.14.2 вимагає зберігати при ротації з детекцією повтору: без нього
 * виявлений повтор не було б чим відкликати. UNIQUE на ньому — у кожного
 * токена щонайбільше один наступник; другий конкурентний рефреш того самого
 * токена не створить другої гілки сімʼї навіть повз FOR UPDATE.
 */
@Entity('refresh_tokens')
@Unique('refresh_tokens_token_hash_key', ['tokenHash'])
@Unique('refresh_tokens_parent_id_key', ['parentId'])
@Index('idx_refresh_tokens_family', ['familyId'])
export class RefreshToken {
  @PrimaryGeneratedColumn('identity', {
    type: 'bigint',
    generatedIdentity: 'ALWAYS',
    primaryKeyConstraintName: 'refresh_tokens_pkey',
  })
  id!: string;

  @Column({ name: 'user_id', type: 'bigint' })
  userId!: string;

  /** Видалили користувача — його сесії зникають разом із ним. */
  @ManyToOne('User', { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id', foreignKeyConstraintName: 'refresh_tokens_user_id_fkey' })
  user!: Relation<User>;

  @Column({ name: 'family_id', type: 'uuid' })
  familyId!: string;

  @Column({ name: 'parent_id', type: 'bigint', nullable: true })
  parentId!: string | null;

  @ManyToOne('RefreshToken', { nullable: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'parent_id', foreignKeyConstraintName: 'refresh_tokens_parent_id_fkey' })
  parent!: Relation<RefreshToken> | null;

  @Column({ name: 'token_hash', type: 'text' })
  tokenHash!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  /** Межа сесії від логіна. Ротація її не відсуває: новий токен успадковує expires_at батька. */
  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt!: Date;

  @Column({ name: 'used_at', type: 'timestamptz', nullable: true })
  usedAt!: Date | null;

  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt!: Date | null;
}
