import type { EntityManager } from 'typeorm';
import { FileEntity } from '../entities/index.js';

export interface NewFile {
  id: string;
  key: string;
  ownerId: string;
  contentType: string;
  // The declared size, in bytes.
  size: number;
}

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
}
