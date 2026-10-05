import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { DatabaseService } from '../../database/database.service';
import { PgClientListFactsRepository } from './adapters/pg-client-list-facts-repository';
import { ClientListFactsService } from './application/client-list-facts.service';
import { ClientListFactsController } from './http/client-list-facts.controller';

/** Read models of the clients screens that the reference data source does not provide. */
@Module({
  imports: [DatabaseModule],
  controllers: [ClientListFactsController],
  providers: [
    {
      provide: ClientListFactsService,
      useFactory: (database: DatabaseService) =>
        new ClientListFactsService({ read: new PgClientListFactsRepository(database), auditClient: database }),
      inject: [DatabaseService],
    },
  ],
})
export class ClientsReadModule {}
