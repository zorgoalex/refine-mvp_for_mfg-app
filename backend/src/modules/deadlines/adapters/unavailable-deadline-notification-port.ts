import { deadlineAdapterUnavailableError } from '../errors/deadline.errors';
import type {
  DeadlineNotificationInput,
  DeadlineNotificationPort,
  DeadlineNotificationResult,
} from '../application/deadline.types';

export class UnavailableDeadlineNotificationPort implements DeadlineNotificationPort {
  async createNotification(_input: DeadlineNotificationInput): Promise<DeadlineNotificationResult> {
    throw deadlineAdapterUnavailableError('deadline_notification_port');
  }
}
