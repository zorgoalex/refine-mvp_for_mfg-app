import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { ExportTemplatesService } from './application/export-templates.service';
import { ExportTemplatesController } from './http/export-templates.controller';

@Module({
  imports: [DatabaseModule],
  controllers: [ExportTemplatesController],
  providers: [ExportTemplatesService],
  exports: [ExportTemplatesService],
})
export class ExportTemplatesModule {}
