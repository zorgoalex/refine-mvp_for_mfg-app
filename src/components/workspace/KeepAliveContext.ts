import { createContext, useContext } from 'react';

interface KeepAliveState {
  isActive: boolean;
  tabKey?: string;
}

export const KeepAliveContext = createContext<KeepAliveState>({ isActive: true });
export const useKeepAlive = () => useContext(KeepAliveContext);

export const useWorkspaceTabKey = (fallbackPathname: string): string => {
  const { tabKey } = useKeepAlive();
  return tabKey ?? fallbackPathname;
};
