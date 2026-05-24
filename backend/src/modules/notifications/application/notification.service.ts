import type { CurrentUser } from '../../../permissions/current-user';
import {
  authRequired,
  invalidNotificationId,
  notificationNotFound,
} from '../errors/notification.errors';
import type {
  NotificationListQuery,
  NotificationListResponse,
  NotificationRepositoryPort,
} from './notification.types';

const uuidRegex =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class NotificationService {
  constructor(private readonly deps: { repository: NotificationRepositoryPort }) {}

  async list(input: {
    currentUser: CurrentUser | undefined;
    query: NotificationListQuery;
  }): Promise<NotificationListResponse> {
    const currentUser = requireCurrentUser(input.currentUser);
    const page = normalizePage(input.query.page);
    const pageSize = normalizePageSize(input.query.pageSize);
    const result = await this.deps.repository.listForUser({
      userId: currentUser.id,
      unreadOnly: input.query.unreadOnly,
      page,
      pageSize,
    });

    return {
      data: result.data,
      pagination: {
        page,
        pageSize,
        total: result.total,
        totalPages: Math.ceil(result.total / pageSize),
      },
      unreadCount: result.unreadCount,
    };
  }

  async markRead(input: { currentUser: CurrentUser | undefined; notificationId: string }) {
    const currentUser = requireCurrentUser(input.currentUser);
    const notificationId = parseNotificationId(input.notificationId);
    const notification = await this.deps.repository.markReadForUser({
      notificationId,
      userId: currentUser.id,
    });

    if (!notification) {
      throw notificationNotFound();
    }

    return { notification };
  }

  async markAllRead(input: { currentUser: CurrentUser | undefined }) {
    const currentUser = requireCurrentUser(input.currentUser);
    const updatedCount = await this.deps.repository.markAllReadForUser(currentUser.id);
    return { updatedCount };
  }

  async delete(input: {
    currentUser: CurrentUser | undefined;
    notificationId: string;
  }): Promise<{ notificationId: string; deleted: true }> {
    const currentUser = requireCurrentUser(input.currentUser);
    const notificationId = parseNotificationId(input.notificationId);
    const deleted = await this.deps.repository.deleteForUser({
      notificationId,
      userId: currentUser.id,
    });

    if (!deleted) {
      throw notificationNotFound();
    }

    return { notificationId, deleted: true };
  }
}

function requireCurrentUser(currentUser: CurrentUser | undefined): CurrentUser {
  if (!currentUser) {
    throw authRequired();
  }
  return currentUser;
}

function parseNotificationId(value: string): string {
  if (!uuidRegex.test(value)) {
    throw invalidNotificationId();
  }
  return value;
}

function normalizePage(value: number): number {
  return Number.isInteger(value) && value > 0 ? value : 1;
}

function normalizePageSize(value: number): number {
  if (!Number.isInteger(value) || value < 1) return 50;
  return Math.min(value, 100);
}
