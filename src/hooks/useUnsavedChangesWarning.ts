// Hook for warning about unsaved changes
// Prevents navigation and page close when form has unsaved changes

import { useEffect, useCallback } from 'react';
import { Modal } from 'antd';

/**
 * Hook to warn users about unsaved changes
 * @param isDirty Whether the form has unsaved changes
 */
export const useUnsavedChangesWarning = (isDirty: boolean) => {
  // Warning when closing/reloading page (browser event)
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (isDirty) {
        e.preventDefault();
        e.returnValue = 'У вас есть несохраненные изменения. Вы уверены, что хотите покинуть страницу?';
        return e.returnValue;
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [isDirty]);

  // Return a function to check before programmatic navigation
  const checkUnsavedChanges = useCallback(
    (callback: () => void) => {
      if (isDirty) {
        Modal.confirm({
          title: 'Несохраненные изменения',
          content: 'У вас есть несохраненные изменения. Вы уверены, что хотите покинуть страницу?',
          okText: 'Покинуть',
          cancelText: 'Остаться',
          onOk: () => {
            callback();
          },
        });
      } else {
        callback();
      }
    },
    [isDirty]
  );

  return { checkUnsavedChanges };
};
