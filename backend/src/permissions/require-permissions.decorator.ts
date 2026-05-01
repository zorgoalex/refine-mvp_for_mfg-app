import { SetMetadata } from '@nestjs/common';
import type { PermissionName } from './permissions';

export const REQUIRED_PERMISSIONS_METADATA_KEY = 'erp:required_permissions';

export function RequirePermissions(
  permissions: PermissionName | readonly PermissionName[],
): ReturnType<typeof SetMetadata> {
  return SetMetadata(
    REQUIRED_PERMISSIONS_METADATA_KEY,
    typeof permissions === 'string' ? [permissions] : [...permissions],
  );
}
