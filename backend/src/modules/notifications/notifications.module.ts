import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { DatabaseService } from '../../database/database.service';
import { PgNotificationRepository } from './adapters/pg-notification-repository';
import { NotificationService } from './application/notification.service';
import { NotificationStreamService } from './application/notification-stream.service';
import { NotificationStreamController } from './http/notification-stream.controller';
import { NotificationsController } from './http/notifications.controller';

@Module({
  imports: [DatabaseModule],
  controllers: [NotificationsController, NotificationStreamController],
  providers: [
    {
      provide: NotificationService,
      useFactory: (database: DatabaseService) =>
        new NotificationService({
          repository: new PgNotificationRepository(database),
        }),
      inject: [DatabaseService],
    },
    NotificationStreamService,
  ],
  exports: [NotificationStreamService],
})
export class NotificationsModule {}
