import React, { lazy } from 'react';
import { useUiVariant } from './UiVariantProvider';
import { isUiVariantFromDeviceHint } from './uiVariantBootstrap';
import type { UiVariant } from './uiVariant';

type ShellModule = { default: React.ComponentType };

const evolutionShellLoader = async (): Promise<ShellModule> => ({
  default: (await import('../ui-evolution/shell/EvolutionWorkspaceLayout')).EvolutionWorkspaceLayout,
});

export const shellLoaders: Record<UiVariant, () => Promise<ShellModule>> = {
  legacy: async () => ({
    default: (await import('../components/workspace/WorkspaceLayout')).WorkspaceLayout,
  }),
  evolution: evolutionShellLoader,
  line: evolutionShellLoader,
  air: evolutionShellLoader,
  neutral: evolutionShellLoader,
  workbench: evolutionShellLoader,
};

const shellRegistry: Record<UiVariant, React.LazyExoticComponent<React.ComponentType>> = {
  legacy: lazy(shellLoaders.legacy),
  evolution: lazy(shellLoaders.evolution),
  line: lazy(shellLoaders.line),
  air: lazy(shellLoaders.air),
  neutral: lazy(shellLoaders.neutral),
  workbench: lazy(shellLoaders.workbench),
};

const ShellLoadingFallback: React.FC = () => (
  <div
    role="status"
    aria-label="Загрузка интерфейса"
    aria-busy="true"
    style={{
      minHeight: '100vh',
      display: 'grid',
      placeItems: 'center',
      color: 'rgba(0, 0, 0, 0.45)',
    }}
  >
    Загрузка интерфейса…
  </div>
);

const HINT_REBOOT_KEY = 'erp.uiVariant.hintReboot';

/**
 * The document was booted signed out with the device-hint variant, yet a
 * session is now authenticated without a reload (sign-in in another tab).
 * Such a document never mounts a shell: the hint is not this user's
 * preference. It reboots once automatically so the bootstrap resolves the
 * user's own variant; if that is impossible (storage blocked) or already
 * used, it asks for a manual reload instead of looping.
 */
export type HintShellState = 'mount' | 'reboot' | 'manual';

export function hintDerivedShellState(
  fromDeviceHint: boolean,
  storage: Pick<Storage, 'getItem'> | null,
): HintShellState {
  if (!fromDeviceHint) return 'mount';
  if (!storage) return 'manual';
  try {
    return storage.getItem(HINT_REBOOT_KEY) === '1' ? 'manual' : 'reboot';
  } catch {
    return 'manual';
  }
}

function sessionStorageOrNull(): Storage | null {
  try {
    return sessionStorage;
  } catch {
    return null;
  }
}

/** Marks the one automatic reboot and reloads; a failed mark means "ask the user". */
export function startHintReboot(
  storage: Pick<Storage, 'setItem'> | null,
  reload: () => void,
): HintShellState {
  if (!storage) return 'manual';
  try {
    storage.setItem(HINT_REBOOT_KEY, '1');
  } catch {
    return 'manual';
  }
  reload();
  return 'reboot';
}

function useHintDerivedShellState(): HintShellState {
  const fromDeviceHint = isUiVariantFromDeviceHint();
  const [state, setState] = React.useState(() => hintDerivedShellState(fromDeviceHint, sessionStorageOrNull()));
  React.useLayoutEffect(() => {
    if (state !== 'reboot') return;
    if (startHintReboot(sessionStorageOrNull(), () => window.location.reload()) === 'manual') {
      setState('manual');
    }
  }, [state]);
  React.useEffect(() => {
    if (fromDeviceHint) return;
    try { sessionStorage.removeItem(HINT_REBOOT_KEY); } catch { /* storage unavailable */ }
  }, [fromDeviceHint]);
  return state;
}

const ShellReloadRequired: React.FC = () => (
  <div
    role="alert"
    style={{
      minHeight: '100vh',
      display: 'grid',
      placeItems: 'center',
      alignContent: 'center',
      gap: 12,
      padding: 16,
      textAlign: 'center',
    }}
  >
    <div>Вход выполнен в другой вкладке. Обновите страницу, чтобы открыть ваш интерфейс.</div>
    <button type="button" onClick={() => window.location.reload()}>
      Обновить страницу
    </button>
  </div>
);

export const VariantWorkspaceLayout: React.FC = () => {
  const { variant } = useUiVariant();
  const hintState = useHintDerivedShellState();
  if (hintState === 'reboot') return <ShellLoadingFallback />;
  if (hintState === 'manual') return <ShellReloadRequired />;
  const Shell = shellRegistry[variant];
  return (
    <React.Suspense fallback={<ShellLoadingFallback />}>
      <Shell />
    </React.Suspense>
  );
};
