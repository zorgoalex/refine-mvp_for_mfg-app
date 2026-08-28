import React from 'react';
import { Alert, Button } from 'antd';
import { fetchLatestBuildSha, getLoadedRuntimeConfig } from '../config/runtimeConfig';
import { getWorkspaceOperationPinDiagnostics } from '../workspace/workspaceOperationPins';
import {
  FRONTEND_VERSION_CHECK_INTERVAL_MS,
  FrontendVersionMonitor,
} from '../version/frontendVersionMonitor';

export const FrontendVersionNotice: React.FC = () => {
  const [latestSha, setLatestSha] = React.useState<string | null>(null);

  React.useEffect(() => {
    const currentSha = getLoadedRuntimeConfig()?.build?.sha?.trim();
    if (!currentSha) return undefined;

    let active = true;
    const monitor = new FrontendVersionMonitor({
      currentSha,
      readLatestSha: fetchLatestBuildSha,
      onVersionAvailable: (sha) => {
        if (active) setLatestSha(sha);
      },
    });
    const check = () => {
      void monitor.check(Date.now(), document.visibilityState === 'visible');
    };
    const timer = window.setInterval(check, FRONTEND_VERSION_CHECK_INTERVAL_MS);
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', check);

    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', check);
    };
  }, []);

  if (!latestSha) return null;

  const handleReload = () => {
    const activeOperationCount = getWorkspaceOperationPinDiagnostics().activePinCount;
    if (
      activeOperationCount > 0
      && !window.confirm('Сейчас выполняется операция. Обновление страницы может прервать её отображение. Обновить приложение?')
    ) {
      return;
    }

    // Existing beforeunload guard owns the warning for unsaved workspace tabs.
    window.location.reload();
  };

  return (
    <Alert
      action={(
        <Button onClick={handleReload} size="small" type="primary">
          Обновить
        </Button>
      )}
      banner
      message="Доступна новая версия приложения"
      role="status"
      showIcon
      style={{ borderRadius: 0 }}
      type="info"
    />
  );
};
