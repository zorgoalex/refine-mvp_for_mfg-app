import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { PermissionsGuard } from '../../permissions/permissions.guard';
import { PermissionsModule } from '../../permissions/permissions.module';
import { FilmSuppliersService } from './application/film-suppliers.service';
import { FilmSuppliersController } from './http/film-suppliers.controller';

/** Поставщики позиций материалов (migr 280): команда для плёнок; листовые и доп. ресурсы пишут список в своих командах. */
@Module({
  imports: [DatabaseModule, PermissionsModule],
  controllers: [FilmSuppliersController],
  providers: [FilmSuppliersService, PermissionsGuard],
})
export class MaterialSuppliersModule {}
