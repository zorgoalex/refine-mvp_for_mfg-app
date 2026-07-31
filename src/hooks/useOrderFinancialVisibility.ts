import { authSession } from '../api/authSession';
import { featureFlags } from '../config/featureFlags';
import { useAppSettings, SETTING_KEYS } from './useAppSettings';
import { authStorage } from '../utils/auth';
import {
  canViewOrderFinancials,
  normalizeOrderFinancialVisibilityMatrix,
  resolveOrderFinancialVisibility,
  type OrderFinancialVisibilityUser,
} from '../utils/orderFinancialVisibility';

export function useOrderFinancialVisibility(
  providedUser?: OrderFinancialVisibilityUser | null,
): { canViewFinancials: boolean; isLoading: boolean } {
  const { getSetting, isLoading } = useAppSettings();
  const currentUser = providedUser ?? (
    featureFlags.useBackendPermissions ? authSession.getUser() : authStorage.getUser()
  );
  const matrix = normalizeOrderFinancialVisibilityMatrix(
    getSetting(SETTING_KEYS.ORDER_FINANCIAL_VISIBILITY),
  );
  const baseAllowed = canViewOrderFinancials(currentUser);

  return {
    // Fail closed while the overlay is loading: restricted data must not flash.
    canViewFinancials: !isLoading && resolveOrderFinancialVisibility({
      baseAllowed,
      user: currentUser,
      matrix,
    }),
    isLoading,
  };
}
