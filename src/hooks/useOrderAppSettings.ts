import { useOrderLifecycleReadActive } from '../query/orderLifecycleQueries';
import { useAppSettings } from './useAppSettings';

export const useOrderAppSettings = () => {
  const ordinaryReadActive = useOrderLifecycleReadActive();
  return useAppSettings({ enabled: ordinaryReadActive });
};
