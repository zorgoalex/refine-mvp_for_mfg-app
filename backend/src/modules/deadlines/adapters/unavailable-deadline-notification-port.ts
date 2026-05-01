import { deadlineAdapterUnavailableError } from '../errors/deadline.errors';
import type { DeadlineNotificationPort } from '../application/deadline.types';

export class UnavailableDeadlineNotificationPort implements DeadlineNotificationPort {
  async createNotification(): Promise<void> {
    throw deadlineAdapterUnavailableError('deadline_notification_port');
  }
}
