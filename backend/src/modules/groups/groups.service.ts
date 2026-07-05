import { ApiError } from '../../common/errors/api-error';
import type { CurrentUser } from '../../permissions/current-user';
import { PermissionsService } from '../../permissions/permissions.service';
import type {
  CreateGroupRequestDto,
  GroupMembersResponseDto,
  GroupDto,
  GroupListQuery,
  GroupListResponseDto,
  GroupLookupResponseDto,
  ReplaceGroupMembersRequestDto,
  UpdateGroupRequestDto,
} from './dto/group.dto';
import type { PermissionName } from '../../permissions/permissions';

export interface GroupLookupQuery {
  search?: string;
  limit: number;
}

export interface GroupRepositoryPort {
  listGroups(query: GroupListQuery): Promise<GroupListResponseDto>;
  lookupGroups(query: GroupLookupQuery): Promise<GroupLookupResponseDto>;
  getGroupById(groupId: string): Promise<GroupDto | null>;
  createGroup(command: CreateGroupCommand): Promise<GroupDto>;
  updateGroup(command: UpdateGroupCommand): Promise<GroupDto>;
  archiveGroup(command: ArchiveGroupCommand): Promise<GroupDto>;
  listGroupMembers(command: ListGroupMembersCommand): Promise<GroupMembersResponseDto>;
  replaceGroupMembers(command: ReplaceGroupMembersCommand): Promise<GroupMembersResponseDto>;
}

export interface GroupsServicePorts {
  groups: GroupRepositoryPort;
  permissions?: PermissionsService;
}

export interface ListGroupsCommand {
  currentUser: CurrentUser;
  query: GroupListQuery;
  requestId?: string;
}

export interface LookupGroupsCommand {
  currentUser: CurrentUser;
  query: GroupLookupQuery;
  requestId?: string;
}

export interface GetGroupByIdCommand {
  currentUser: CurrentUser;
  groupId: string;
  requestId?: string;
}

export interface CreateGroupCommand {
  currentUser: CurrentUser;
  dto: CreateGroupRequestDto;
  requestId?: string;
}

export interface UpdateGroupCommand {
  currentUser: CurrentUser;
  groupId: string;
  dto: UpdateGroupRequestDto;
  requestId?: string;
}

export interface ArchiveGroupCommand {
  currentUser: CurrentUser;
  groupId: string;
  requestId?: string;
}

export interface ListGroupMembersCommand {
  currentUser: CurrentUser;
  groupId: string;
  requestId?: string;
}

export interface ReplaceGroupMembersCommand {
  currentUser: CurrentUser;
  groupId: string;
  dto: ReplaceGroupMembersRequestDto;
  requestId?: string;
}

export class GroupsService {
  private readonly permissions: PermissionsService;

  constructor(private readonly ports: GroupsServicePorts) {
    this.permissions = ports.permissions ?? new PermissionsService();
  }

  async list(command: ListGroupsCommand): Promise<GroupListResponseDto> {
    this.requireView(command.currentUser);
    return this.ports.groups.listGroups(command.query);
  }

  async lookup(command: LookupGroupsCommand): Promise<GroupLookupResponseDto> {
    this.requireView(command.currentUser);
    return this.ports.groups.lookupGroups(command.query);
  }

  async getById(command: GetGroupByIdCommand): Promise<GroupDto> {
    this.requireView(command.currentUser);

    const group = await this.ports.groups.getGroupById(command.groupId);
    if (!group) {
      throw new GroupNotFoundError(command.groupId);
    }

    return group;
  }

  async create(command: CreateGroupCommand): Promise<GroupDto> {
    this.requirePermission(command.currentUser, 'groups.create');
    return this.ports.groups.createGroup(command);
  }

  async update(command: UpdateGroupCommand): Promise<GroupDto> {
    this.requirePermission(command.currentUser, 'groups.update');
    return this.ports.groups.updateGroup(command);
  }

  async archive(command: ArchiveGroupCommand): Promise<GroupDto> {
    this.requirePermission(command.currentUser, 'groups.archive');
    return this.ports.groups.archiveGroup(command);
  }

  async listMembers(command: ListGroupMembersCommand): Promise<GroupMembersResponseDto> {
    this.requirePermission(command.currentUser, 'groups.members.view');
    return this.ports.groups.listGroupMembers(command);
  }

  async replaceMembers(command: ReplaceGroupMembersCommand): Promise<GroupMembersResponseDto> {
    this.requirePermission(command.currentUser, 'groups.members.manage');
    return this.ports.groups.replaceGroupMembers(command);
  }

  private requireView(currentUser: CurrentUser): void {
    this.requirePermission(currentUser, 'groups.view');
  }

  private requirePermission(currentUser: CurrentUser, permission: string): void {
    const typedPermission = permission as PermissionName;
    if (!this.permissions.canUser(currentUser, typedPermission)) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для выполнения действия', {
        requiredPermissions: [permission],
      });
    }
  }
}

export class GroupNotFoundError extends ApiError {
  constructor(groupId: string) {
    super(404, 'GROUP_NOT_FOUND', 'Group not found', { groupId });
  }
}
