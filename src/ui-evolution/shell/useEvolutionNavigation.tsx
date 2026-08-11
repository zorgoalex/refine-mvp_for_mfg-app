import React, { useCallback, useMemo, useState } from 'react';
import { ContactsOutlined } from '@ant-design/icons';
import { useNavigation, useResource } from '@refinedev/core';
import { useLocation } from 'react-router-dom';
import { authSession } from '../../api/authSession';
import { bitrix24MenuConfig } from '../../config/bitrix24';
import { featureFlags } from '../../config/featureFlags';
import { useAppSettings, SETTING_KEYS } from '../../hooks/useAppSettings';
import { useSidebarMenuPreferences } from '../../hooks/useSidebarMenuPreferences';
import { authStorage } from '../../utils/auth';
import {
  canViewNavigationResource,
  canViewSettingsCategory,
  isLegacyAdminUser,
} from '../../utils/navigationPermissions';
import { canManageOrderContent } from '../../utils/orderFinancialVisibility';
import { useOrderFinancialVisibility } from '../../hooks/useOrderFinancialVisibility';
import {
  canViewResourceByRoleVisibility,
  getCurrentUserRoleKey,
  normalizeRoleVisibilityMatrix,
} from '../../utils/resourceVisibility';
import { RESOURCE_LABELS } from '../../utils/tabLabels';
import { useSiderMenuItems } from '../../utils/siderMenuItems';
import { SIDER_RESOURCE_ICONS } from '../../components/siderResourceIcons';

// Keep the shared permission-bearing category ID `Настройки`; only its visual
// label changes in the evolution shell. buildCategorizedResources deliberately
// applies canViewSettings to this exact stable ID.
export const EVOLUTION_CATEGORY_ORDER = ['CRM', 'Производство', 'Данные', 'Журналы', 'Настройки'] as const;

export const EVOLUTION_CATEGORY_LABELS: Record<(typeof EVOLUTION_CATEGORY_ORDER)[number], string> = {
  CRM: 'CRM',
  Производство: 'Производство',
  Данные: 'Данные',
  Журналы: 'Журналы',
  Настройки: 'Система',
};

export const EVOLUTION_CATEGORY_MAP: Record<string, (typeof EVOLUTION_CATEGORY_ORDER)[number]> = {
  clients: 'CRM',
  clients_analytics_view: 'CRM',
  suppliers: 'CRM',
  vendors: 'CRM',
  film_vendors: 'CRM',
  payments: 'CRM',
  payments_view: 'CRM',
  'orders-trash': 'Данные',
  'mdf-work-board': 'Производство',
  groups: 'Производство',
  projects: 'Производство',
  order_workshops: 'Производство',
  workshops: 'Производство',
  work_centers: 'Производство',
  order_resource_requirements: 'Производство',
  doweling_orders_view: 'Производство',
  bazis: 'Производство',
  'cut-jobs': 'Производство',
  'bazis-cut-sets': 'Производство',
  scan: 'Производство',
  films: 'Данные',
  materials: 'Данные',
  sheet_material_types: 'Данные',
  milling_types: 'Данные',
  edge_types: 'Данные',
  film_types: 'Данные',
  material_types: 'Данные',
  units: 'Данные',
  order_statuses: 'Данные',
  payment_statuses: 'Данные',
  payment_types: 'Данные',
  requisition_statuses: 'Данные',
  movements_statuses: 'Данные',
  material_transaction_types: 'Данные',
  transaction_direction: 'Данные',
  production_statuses: 'Данные',
  resource_requirements_statuses: 'Данные',
  employees: 'Настройки',
  users: 'Настройки',
  configuration: 'Настройки',
  audit: 'Журналы',
};

export function useEvolutionNavigation(onNavigate?: () => void) {
  const { resources } = useResource();
  const { push } = useNavigation();
  const location = useLocation();
  const { getSetting } = useAppSettings();
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const sidebarMenuPreferences = useSidebarMenuPreferences();

  const currentUser = featureFlags.useBackendPermissions
    ? authSession.getUser()
    : authStorage.getUser();
  const { canViewFinancials } = useOrderFinancialVisibility(currentUser);
  const currentRoleKey = getCurrentUserRoleKey(currentUser);
  const roleVisibilityMatrix = normalizeRoleVisibilityMatrix(
    getSetting(SETTING_KEYS.RESOURCE_VISIBILITY_BY_ROLE),
  );
  const legacyIsAdmin = useMemo(
    () => isLegacyAdminUser(currentUser, featureFlags.useBackendPermissions),
    [currentUser],
  );
  const canViewSettings = useMemo(
    () => canViewSettingsCategory(currentUser, featureFlags.useBackendPermissions, legacyIsAdmin),
    [currentUser, legacyIsAdmin],
  );
  const canCreateOrders = useMemo(
    () => canManageOrderContent('orders.create', currentUser, canViewFinancials),
    [canViewFinancials, currentUser],
  );
  const canViewNavigation = useCallback(
    (name: string) =>
      canViewNavigationResource(name, currentUser, featureFlags.useBackendPermissions, canViewFinancials) &&
      canViewResourceByRoleVisibility(name, currentRoleKey, roleVisibilityMatrix),
    [canViewFinancials, currentRoleKey, currentUser, roleVisibilityMatrix],
  );

  const navigate = useCallback((route: string) => {
    push(route);
    onNavigate?.();
  }, [onNavigate, push]);

  const sider = useSiderMenuItems({
    resources,
    pathname: location.pathname,
    push: navigate,
    categoryOrder: EVOLUTION_CATEGORY_ORDER,
    categoryMap: EVOLUTION_CATEGORY_MAP,
    resourceLabels: RESOURCE_LABELS,
    resourceIcons: SIDER_RESOURCE_ICONS,
    canViewNavigation,
    canViewSettings,
    canCreateOrders,
    setIsCreateModalOpen,
    crm: bitrix24MenuConfig
      ? { ...bitrix24MenuConfig, icon: <ContactsOutlined /> }
      : null,
    sidebarMenuOrder: sidebarMenuPreferences.settings,
  });

  return { sider, isCreateModalOpen, setIsCreateModalOpen, sidebarMenuPreferences };
}
