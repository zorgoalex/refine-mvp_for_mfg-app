import React, { lazy } from 'react';
import { useUiVariant } from './UiVariantProvider';
import type { UiVariant } from './uiVariant';

type ShellModule = { default: React.ComponentType };

export const shellLoaders: Record<UiVariant, () => Promise<ShellModule>> = {
  legacy: async () => ({
    default: (await import('../components/workspace/WorkspaceLayout')).WorkspaceLayout,
  }),
  evolution: async () => ({
    default: (await import('../ui-evolution/shell/EvolutionWorkspaceLayout')).EvolutionWorkspaceLayout,
  }),
};

const shellRegistry: Record<UiVariant, React.LazyExoticComponent<React.ComponentType>> = {
  legacy: lazy(shellLoaders.legacy),
  evolution: lazy(shellLoaders.evolution),
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

export const VariantWorkspaceLayout: React.FC = () => {
  const { variant } = useUiVariant();
  const Shell = shellRegistry[variant];
  return (
    <React.Suspense fallback={<ShellLoadingFallback />}>
      <Shell />
    </React.Suspense>
  );
};
