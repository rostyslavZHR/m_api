import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { S3Client } from '@aws-sdk/client-s3';
import type { ApiEnv } from '../config/env.schema.js';
import { type StorageConfig, storageConfigOf } from '../config/storage.js';
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
export class StorageModule implements OnApplicationShutdown {
  constructor(@Inject(S3) private readonly s3: S3Client) {}

  // Closes the client's keep-alive sockets, so the process can exit.
  onApplicationShutdown(): void {
    this.s3.destroy();
  }
}
