import { ApiError } from '../../../common/errors/api-error';
import type { CurrentUser } from '../../../permissions/current-user';
import { PermissionsService } from '../../../permissions/permissions.service';
import { readMdfPublishedSnapshot, type MdfPublishedQuery } from '../adapters/mdf-published-snapshot';
import type { MdfJobDatabase } from './mdf-job-runner';

export class MdfPublishedBoardService {
  constructor(private readonly database: MdfJobDatabase,private readonly permissions: PermissionsService) {}
  get(user: CurrentUser,query: MdfPublishedQuery) {
    if (!this.permissions.canUser(user,'orders.view')) throw new ApiError(403,'PERMISSION_DENIED',
      'Недостаточно прав для просмотра МДФ-доски',{ requiredPermissions: ['orders.view'] });
    if (process.env.BACKEND_MDF_PUBLISHED_READS!=='true') throw new ApiError(503,'MDF_PUBLICATION_DISABLED',
      'Новый механизм МДФ-доски ещё не подключён');
    return readMdfPublishedSnapshot(this.database,user,query);
  }
}
