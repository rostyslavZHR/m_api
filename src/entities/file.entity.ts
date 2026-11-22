import { Check, Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn, type Relation, Unique } from 'typeorm';
import { UserEntity } from './user.entity.js';

// The source of truth for a file's states: the TS type and the CHECK come from this list.
//   PENDING    intent issued a presigned PUT; the bytes may or may not be in the store yet
//   COMPLETED  commit found the object in the store, with the declared size and type
export const FILE_STATUSES = ['PENDING', 'COMPLETED'] as const;
export type FileStatus = (typeof FILE_STATUSES)[number];

const statusList = FILE_STATUSES.map((status) => `'${status}'`).join(', ');

// One row per upload (HW#26). The store holds the bytes; this table is the index of what
// exists and whose it is (#179: "S3 keeps the bytes; your database keeps the list").
@Entity('files')
@Unique('files_key_key', ['key'])
@Check('files_status_check', `status IN (${statusList})`)
@Check('files_size_check', 'size > 0')
// The FK's index: "this user's files", and the RESTRICT check on deleting a user.
@Index('files_owner_id_idx', ['ownerId'])
export class FileEntity {
  // Made by the server (randomUUID) before the insert, because the object key is built
  // from it: uploads/{ownerId}/{id}.{ext}.
  @PrimaryColumn('uuid')
  id: string;

  // The object's key in the bucket. Built by the server only, never from the client's
  // filename.
  @Column('text')
  key: string;

  @Column('bigint', { name: 'owner_id' })
  ownerId: string;

  // RESTRICT: a user with files can't be deleted until the files (and their objects)
  // are, or the objects would be orphans nobody owns.
  @ManyToOne(() => UserEntity, { onDelete: 'RESTRICT', nullable: false })
  @JoinColumn({ name: 'owner_id' })
  owner: Relation<UserEntity>;

  @Column('text', { default: 'PENDING' })
  status: FileStatus;

  // The signed Content-Type: the client must PUT exactly this header.
  @Column('text', { name: 'content_type' })
  contentType: string;

  // Bytes. Declared at intent; on commit it must equal the object's ContentLength.
  // bigint, so pg returns it as a string.
  @Column('bigint')
  size: string;

  // The multipart upload's id (Phase D). Null for a single PUT.
  @Column('text', { name: 'upload_id', nullable: true })
  uploadId: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @Column('timestamptz', { name: 'completed_at', nullable: true })
  completedAt: Date | null;
}
