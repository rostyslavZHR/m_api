import { Module } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DbModule } from '../db/db.module.js';
import { FilesRepository } from './files.repository.js';
import { UploadsController } from './uploads.controller.js';
import { UploadsService } from './uploads.service.js';

// The S3 client and the storage config come from the global StorageModule.
@Module({
  imports: [DbModule],
  controllers: [UploadsController],
  providers: [
    {
      provide: FilesRepository,
      useFactory: (dataSource: DataSource) => new FilesRepository(dataSource.manager),
      inject: [DataSource],
    },
    UploadsService,
  ],
})
export class UploadsModule {}
