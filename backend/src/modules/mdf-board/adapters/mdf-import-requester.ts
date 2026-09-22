import { ApiError } from '../../../common/errors/api-error';
import type { TransactionClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import type { UserRole } from '../../../permissions/permissions';
import type { Scope } from '../../../permissions/policies/role-policies';

/** Delegated worker commands must authorize the living requester, not the
 * worker's role or the role defaults captured when an import was prepared.
 * Called before domain locks. Matrix edits serialize on permissions_state. */
export async function lockMdfImportRequester(tx: TransactionClient, id: string): Promise<CurrentUser> {
  const version=(await tx.query<{version:number}>('SELECT version FROM permissions_state WHERE id=true FOR SHARE')).rows[0];
  const row=(await tx.query<{id:string;username:string;roleId:number;role:string}>(`SELECT u.user_id::text id,
    u.username,u.role_id "roleId",r.role_code role FROM users u JOIN roles r ON r.role_id=u.role_id
    WHERE u.user_id=$1 AND u.is_active AND r.is_active FOR SHARE OF u,r`,[id])).rows[0];
  if (!version || !row) denied();
  const permissions=(await tx.query<{name:'cut.manage'|'orders.view'}>(`SELECT rp.permission_name name
    FROM role_permissions rp JOIN permissions_catalog pc USING(permission_name)
    WHERE rp.role_id=$1 AND rp.is_enabled AND pc.is_active AND rp.permission_name IN ('cut.manage','orders.view')`,[row.roleId])).rows.map(r=>r.name);
  const scope=(await tx.query<{scope:Scope}>(`SELECT scope_value scope FROM role_policy_scopes
    WHERE role_id=$1 AND scope_key='orders.view'`,[row.roleId])).rows[0]?.scope ?? 'none';
  if (permissions.length!==2 || !['all','own','assigned'].includes(scope)) denied();
  const role=(['superadmin','admin','top_manager','manager','operator','worker','packer','viewer'].includes(row.role)
    ? row.role : 'worker') as UserRole;
  // Least authority: this command needs only orders.view and cut.manage. Do not
  // silently restore broader policy scopes from a static role fallback.
  return {id:row.id,username:row.username,roleId:row.roleId,role,permissions,permissionsVersion:Number(version.version),
    policyScopes:{orders:{view:scope,update:'none',export:'none',delete:'none'},
      payments:{view:'none',create:'none',update:'none',delete:'none'},productionTasks:{view:'none',update:'none'}}};
}

function denied():never { throw new ApiError(403,'PERMISSION_DENIED','Инициатор импорта отключён или больше не имеет доступа'); }
