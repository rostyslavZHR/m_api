import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, Unique } from 'typeorm';

// @Unique at class level rather than { unique: true } on the column, so the
// constraint keeps Postgres's name from HW#12 instead of a generated UQ_<hash>.
@Entity('users')
@Unique('users_email_key', ['email'])
export class UserEntity {
  @PrimaryGeneratedColumn('identity', { type: 'bigint', generatedIdentity: 'ALWAYS' })
  id: string;

  @Column('text')
  email: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
