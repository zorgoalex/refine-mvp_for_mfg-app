import type { CurrentUser } from '../../../permissions/current-user';
import {
  authRequired,
  invalidNotificationId,
  notificationBalloonPending,
  notificationNotFound,
} from '../errors/notification.errors';
import type {
  NotificationListQuery,
  NotificationListResponse,
  NotificationRepositoryPort,
} from './notification.types';

/** Мест на экране балунов вкладки (план 2026-10-03 §2.2): за один claim — не больше. */
export const MAX_BALLOONS_PER_CLAIM = 5;
/**
 * Возможность клиента показывать обязательные балуны (план 2026-10-19 §2.7): заявляется заголовком
 * `X-Balloon-Capabilities`, а не телом claim — старый backend со строгой схемой тела заголовок просто игнорирует.
 */
export const MANDATORY_BALLOON_CAPABILITY = 'mandatory';

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
      viewer: currentUser,
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
      viewer: currentUser,
    });

    if (!notification) {
      throw notificationNotFound();
    }

    return { notification };
  }

  async markAllRead(input: { currentUser: CurrentUser | undefined }) {
    const currentUser = requireCurrentUser(input.currentUser);
    const updatedCount = await this.deps.repository.markAllReadForUser(currentUser);
    return { updatedCount };
  }

  async claimBalloons(input: { currentUser: CurrentUser | undefined; token: string; limit: number; capabilities?: readonly string[] }) {
    const currentUser = requireCurrentUser(input.currentUser);
    const token = parseNotificationId(input.token);
    const limit = Math.min(Math.max(Math.trunc(input.limit), 1), MAX_BALLOONS_PER_CLAIM);
    const mandatory = (input.capabilities ?? []).includes(MANDATORY_BALLOON_CAPABILITY);
    const items = await this.deps.repository.claimBalloonsForUser({ viewer: currentUser, token, limit, mandatory });
    return { items };
  }

  async ackBalloons(input: { currentUser: CurrentUser | undefined; token: string; notificationIds: string[] }) {
    const currentUser = requireCurrentUser(input.currentUser);
    const token = parseNotificationId(input.token);
    const notificationIds = [...new Set(input.notificationIds.map(parseNotificationId))];
    const acknowledged = await this.deps.repository.ackBalloonsForUser({ viewer: currentUser, token, notificationIds });
    return { acknowledged };
  }

  async delete(input: {
    currentUser: CurrentUser | undefined;
    notificationId: string;
  }): Promise<{ notificationId: string; deleted: true }> {
    const currentUser = requireCurrentUser(input.currentUser);
    const notificationId = parseNotificationId(input.notificationId);
    const result = await this.deps.repository.deleteForUser({
      notificationId,
      viewer: currentUser,
    });

    if (result === 'balloon_pending') {
      throw notificationBalloonPending();
    }
    if (result !== 'deleted') {
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
