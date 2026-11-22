import { Global, Inject, Logger, Module, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { S3Client } from '@aws-sdk/client-s3';
import type { ApiEnv } from '../config/env.schema.js';
import { type StorageConfig, storageConfigOf } from '../config/storage.js';
import { applyLifecycle } from './lifecycle.js';
import { createS3Client } from './s3-client.js';

// Injection tokens: @Inject(S3) for the one shared client, @Inject(STORAGE_CONFIG) for
// the bucket name and the rest of the config.
export const S3 = Symbol('S3');
export const STORAGE_CONFIG = Symbol('STORAGE_CONFIG');

@Global()
@Module({
  providers: [
    {
      provide: STORAGE_CONFIG,
      useFactory: (config: ConfigService<ApiEnv, true>): StorageConfig =>
        storageConfigOf({
          S3_ENDPOINT: config.get('S3_ENDPOINT', { infer: true }),
          S3_REGION: config.get('S3_REGION', { infer: true }),
          S3_ACCESS_KEY_ID: config.get('S3_ACCESS_KEY_ID', { infer: true }),
          S3_SECRET_ACCESS_KEY: config.get('S3_SECRET_ACCESS_KEY', { infer: true }),
          S3_BUCKET: config.get('S3_BUCKET', { infer: true }),
        }),
      inject: [ConfigService],
    },
    {
      provide: S3,
      useFactory: (storage: StorageConfig) => createS3Client(storage),
      inject: [STORAGE_CONFIG],
    },
  ],
  exports: [S3, STORAGE_CONFIG],
})
export class StorageModule implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(StorageModule.name);

  constructor(
    @Inject(S3) private readonly s3: S3Client,
    @Inject(STORAGE_CONFIG) private readonly storage: StorageConfig,
  ) {}

  // The bucket's lifecycle rule (abort unfinished multipart uploads after 7 days), set at
  // every start: idempotent, and the dev store forgets it on a restart (tmpfs). A failure
  // doesn't stop the API (the store may come up later); it's logged, and our own daily
  // cleanup still aborts the uploads it has rows for.
  async onApplicationBootstrap(): Promise<void> {
    try {
      await applyLifecycle(this.s3, this.storage.bucket);
      this.logger.log(`bucket ${this.storage.bucket}: lifecycle rule set (abort unfinished multipart uploads after 7 days)`);
    } catch (error) {
      this.logger.warn(`bucket ${this.storage.bucket}: lifecycle rule not set (${(error as Error).name}: ${(error as Error).message})`);
    }
  }

  // Closes the client's keep-alive sockets, so the process can exit.
  onApplicationShutdown(): void {
    this.s3.destroy();
  }
}
