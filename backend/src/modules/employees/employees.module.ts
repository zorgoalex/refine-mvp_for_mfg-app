import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { PermissionsGuard } from '../../permissions/permissions.guard';
import { PermissionsModule } from '../../permissions/permissions.module';
import { EmployeeContactsController } from './employee-contacts.controller';
import { EmployeeContactsRepository } from './employee-contacts.repository';

/** Employees owned by the backend: work contacts (the employees reference itself stays on Hasura). */
@Module({
  imports: [DatabaseModule, PermissionsModule],
  controllers: [EmployeeContactsController],
  providers: [EmployeeContactsRepository, PermissionsGuard],
  exports: [EmployeeContactsRepository],
})
export class EmployeesModule {}
