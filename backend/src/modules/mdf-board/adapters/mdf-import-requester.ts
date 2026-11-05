import { ApiError } from '../../../common/errors/api-error';
import type { TransactionClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import type { UserRole } from '../../../permissions/permissions';
import { scalarScope } from '../../../permissions/policies/scope-sets';
import { parseAuthorizationSnapshot, type RawAuthorizationSnapshot } from '../../../permissions/user-authorization-snapshot';

/** Delegated worker commands must authorize the living requester, not the
 * worker's role or the role defaults captured when an import was prepared.
 * Called before domain locks. Matrix edits serialize on permissions_state. */
export async function lockMdfImportRequester(tx: TransactionClient, id: string): Promise<CurrentUser> {
  const version=(await tx.query<{version:number}>('SELECT version FROM permissions_state WHERE id=true FOR SHARE')).rows[0];
  const row=(await tx.query<{id:string;username:string;roleId:number;role:string}>(`SELECT u.user_id::text id,
    u.username,u.role_id "roleId",r.role_code role FROM users u JOIN roles r ON r.role_id=u.role_id
    WHERE u.user_id=$1 AND u.is_active AND r.is_active FOR SHARE OF u,r`,[id])).rows[0];
  if (!version || !row) denied();
  // Effective grants and scope set from the same one-statement snapshot as the token, under the locks above.
  const raw=(await tx.query<{snapshot:RawAuthorizationSnapshot|null}>(
    'SELECT public.user_authorization_snapshot($1::bigint) AS snapshot',[id])).rows[0]?.snapshot;
  const snapshot=raw ? parseAuthorizationSnapshot(raw) : null;
  const permissions=(snapshot?.permissions ?? []).filter((name): name is 'cut.manage'|'orders.view' =>
    name==='cut.manage' || name==='orders.view');
  const viewSet=snapshot?.scopeSets.orders.view ?? [];
  if (new Set(permissions).size!==2 || viewSet.length===0) denied();
  const role=(['superadmin','admin','top_manager','manager','operator','worker','packer','viewer'].includes(row.role)
    ? row.role : 'worker') as UserRole;
  // Least authority: this command needs only orders.view and cut.manage. Do not
  // silently restore broader policy scopes from a static role fallback.
  return {id:row.id,username:row.username,roleId:row.roleId,role,permissions,permissionsVersion:Number(version.version),
    policyScopes:{orders:{view:scalarScope(viewSet),update:'none',export:'none',delete:'none'},
      payments:{view:'none',create:'none',update:'none',delete:'none'},productionTasks:{view:'none',update:'none'}},
    policyScopeSets:{orders:{view:viewSet,update:[],export:[],delete:[]},
      payments:{view:[],create:[],update:[],delete:[]},productionTasks:{view:[],update:[]}}};
}

function denied():never { throw new ApiError(403,'PERMISSION_DENIED','Инициатор импорта отключён или больше не имеет доступа'); }
