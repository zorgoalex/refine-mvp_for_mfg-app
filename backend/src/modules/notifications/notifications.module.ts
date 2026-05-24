import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { DatabaseService } from '../../database/database.service';
import { PgNotificationRepository } from './adapters/pg-notification-repository';
import { NotificationService } from './application/notification.service';
import { NotificationsController } from './http/notifications.controller';

@Module({
  imports: [DatabaseModule],
  controllers: [NotificationsController],
  providers: [
    {
      provide: NotificationService,
      useFactory: (database: DatabaseService) =>
        new NotificationService({
          repository: new PgNotificationRepository(database),
        }),
      inject: [DatabaseService],
    },
  ],
})
export class NotificationsModule {}
