import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { DatabaseService } from '../../database/database.service';
import { PgClientListFactsRepository } from './adapters/pg-client-list-facts-repository';
import { ClientListFactsService } from './application/client-list-facts.service';
import { ClientListFactsController } from './http/client-list-facts.controller';
import { PgClientsAnalyticsRepository } from './adapters/pg-clients-analytics-repository';
import { ClientsAnalyticsService } from './application/clients-analytics.service';
import { ClientsAnalyticsController } from './http/clients-analytics.controller';

/** Read models of the clients screens that the reference data source does not provide. */
@Module({
  imports: [DatabaseModule],
  controllers: [ClientListFactsController, ClientsAnalyticsController],
  providers: [
    {
      provide: ClientListFactsService,
      useFactory: (database: DatabaseService) =>
        new ClientListFactsService({ read: new PgClientListFactsRepository(database), auditClient: database }),
      inject: [DatabaseService],
    },
    {
      provide: ClientsAnalyticsService,
      useFactory: (database: DatabaseService) =>
        new ClientsAnalyticsService({ read: new PgClientsAnalyticsRepository(database), auditClient: database }),
      inject: [DatabaseService],
    },
  ],
})
export class ClientsReadModule {}
