import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { DatabaseService } from '../../database/database.service';
import { PgProfilePreferencesRepository } from './pg-profile-preferences.repository';
import { ProfilePreferencesController } from './profile-preferences.controller';
import { ProfilePreferencesService } from './profile-preferences.service';

@Module({
  imports: [DatabaseModule],
  controllers: [ProfilePreferencesController],
  providers: [
    {
      provide: ProfilePreferencesService,
      useFactory: (database: DatabaseService) =>
        new ProfilePreferencesService(new PgProfilePreferencesRepository(database)),
      inject: [DatabaseService],
    },
  ],
})
export class ProfileModule {}
