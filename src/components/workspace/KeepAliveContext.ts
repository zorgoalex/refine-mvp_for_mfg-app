import {
  createContext,
  createElement,
  useContext,
  useMemo,
  type PropsWithChildren,
} from 'react';

export interface WorkspaceActivity {
  tabKey: string;
  workspaceActive: boolean;
  activationRevision: number;
}

export interface KeepAliveState extends WorkspaceActivity {
  isActive: boolean;
  documentVisible: boolean;
  surfaceActive: boolean;
}

export interface WorkspaceActivationTracker {
  lastActiveKey: string;
  nextRevision: number;
  revisionByKey: Map<string, number>;
}

const DEFAULT_WORKSPACE_ACTIVITY: KeepAliveState = {
  isActive: true,
  tabKey: '',
  workspaceActive: true,
  activationRevision: 0,
  documentVisible: true,
  surfaceActive: true,
};

export const KeepAliveContext = createContext<KeepAliveState>(DEFAULT_WORKSPACE_ACTIVITY);
export const useKeepAlive = () => useContext(KeepAliveContext);

export const isWorkspaceOrdinaryReadActive = ({
  workspaceActive,
  surfaceActive,
  documentVisible,
}: Pick<KeepAliveState, 'workspaceActive' | 'surfaceActive' | 'documentVisible'>): boolean =>
  workspaceActive && surfaceActive && documentVisible;

export const activateWorkspace = (
  tracker: WorkspaceActivationTracker,
  tabKey: string,
): number => {
  if (tracker.lastActiveKey !== tabKey) {
    tracker.nextRevision += 1;
    tracker.lastActiveKey = tabKey;
    tracker.revisionByKey.set(tabKey, tracker.nextRevision);
  }
  return tracker.revisionByKey.get(tabKey) ?? 0;
};

export const OrderReadSurface = ({
  active,
  children,
}: PropsWithChildren<{ active: boolean }>) => {
  const parent = useKeepAlive();
  const value = useMemo<KeepAliveState>(() => ({
    ...parent,
    surfaceActive: parent.surfaceActive && active,
  }), [active, parent]);

  return createElement(KeepAliveContext.Provider, { value }, children);
};

export const useWorkspaceTabKey = (fallbackPathname: string): string => {
  const { tabKey } = useKeepAlive();
  return tabKey || fallbackPathname;
};
