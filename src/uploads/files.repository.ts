import { type EntityManager, LessThan } from 'typeorm';
import { FileEntity } from '../entities/index.js';

export interface NewFile {
  id: string;
  key: string;
  ownerId: string;
  contentType: string;
  // The declared size, in bytes.
  size: number;
}

// What the cleanup needs of an abandoned upload.
export type AbandonedFile = Pick<FileEntity, 'id' | 'key' | 'uploadId'>;

export interface CompleteFile {
  id: string;
  // The object's real size, from HeadObject.
  size: number;
  completedAt: Date;
}

// Takes an EntityManager, like the other repositories.
export class FilesRepository {
  constructor(private readonly manager: EntityManager) {}

  async insert({ size, ...file }: NewFile): Promise<void> {
    await this.manager.insert(FileEntity, { ...file, size: String(size), status: 'PENDING' });
  }

  findById(id: string): Promise<FileEntity | null> {
    return this.manager.findOneBy(FileEntity, { id });
  }

  // Guarded: completes the file only if it's still PENDING. false means another commit
  // got there first; the caller reads the row again.
  async markCompleted({ id, size, completedAt }: CompleteFile): Promise<boolean> {
    const result = await this.manager
      .createQueryBuilder()
      .update(FileEntity)
      .set({ status: 'COMPLETED', size: String(size), completedAt })
      .where('id = :id AND status = :pending', { id, pending: 'PENDING' })
      .execute();
    return result.affected === 1;
  }

  // Uploads that never completed: PENDING, created before the cutoff. Oldest first, a
  // batch at a time.
  findPendingOlderThan(cutoff: Date, limit: number): Promise<AbandonedFile[]> {
    return this.manager.find(FileEntity, {
      select: { id: true, key: true, uploadId: true },
      where: { status: 'PENDING', createdAt: LessThan(cutoff) },
      order: { createdAt: 'ASC' },
      take: limit,
    });
  }

  // Conditional, like markCompleted: deletes the row only if it's still PENDING. false
  // means a commit completed it after the cleanup read it: the file stays, and so must
  // its object.
  async deleteIfPending(id: string): Promise<boolean> {
    const result = await this.manager
      .createQueryBuilder()
      .delete()
      .from(FileEntity)
      .where('id = :id AND status = :pending', { id, pending: 'PENDING' })
      .execute();
    return result.affected === 1;
  }
}
