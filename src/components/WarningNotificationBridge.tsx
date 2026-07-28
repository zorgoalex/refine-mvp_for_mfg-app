import { useEffect } from 'react';
import { useNotificationStore } from '../stores/notificationStore';
import { authStorage } from '../utils/auth';
import { observeUserWarnings } from '../utils/warningNotificationCapture';

export function WarningNotificationBridge() {
  useEffect(() => {
    if (!document.body) return;

    return observeUserWarnings(document.body, (message) => {
      const user = authStorage.getUser();
      if (!user?.id) return;

      useNotificationStore
        .getState()
        .addNotification(message, 'warning', { userId: user.id });
    });
  }, []);

  return null;
}
