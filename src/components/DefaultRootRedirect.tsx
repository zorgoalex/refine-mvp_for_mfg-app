import React, { useCallback, useMemo } from 'react';
import { useResource } from '@refinedev/core';
import { Navigate } from 'react-router-dom';
import { Spin } from 'antd';
import { authSession } from '../api/authSession';
import { featureFlags } from '../config/featureFlags';
import { useAppSettings, SETTING_KEYS } from '../hooks/useAppSettings';
import { useSidebarMenuPreferences } from '../hooks/useSidebarMenuPreferences';
import { useUiVariant } from '../ui-variant/UiVariantProvider';
import { authStorage } from '../utils/auth';
import {
  canViewNavigationResource,
  canViewSettingsCategory,
  isLegacyAdminUser,
} from '../utils/navigationPermissions';
import { getSidebarMenuConfig } from '../utils/navigationMenuConfig';
import {
  canViewOrderFinancials,
  normalizeOrderFinancialVisibilityMatrix,
  resolveOrderFinancialVisibility,
} from '../utils/orderFinancialVisibility';
import {
  canViewResourceByRoleVisibility,
  getCurrentUserRoleKey,
  normalizeRoleVisibilityMatrix,
} from '../utils/resourceVisibility';
import { useSiderMenuItems } from '../utils/siderMenuItems';
import { RESOURCE_LABELS } from '../utils/tabLabels';

export const DefaultRootRedirect: React.FC = () => {
  const { resources } = useResource();
  const { variant } = useUiVariant();
  const { getSetting, isLoading: appSettingsLoading } = useAppSettings();
  const sidebarMenuPreferences = useSidebarMenuPreferences();
  const currentUser = featureFlags.useBackendPermissions
    ? authSession.getUser()
    : authStorage.getUser();
  const currentRoleKey = getCurrentUserRoleKey(currentUser);
  const roleVisibilityMatrix = normalizeRoleVisibilityMatrix(
    getSetting(SETTING_KEYS.RESOURCE_VISIBILITY_BY_ROLE),
  );
  const financialVisibilityMatrix = normalizeOrderFinancialVisibilityMatrix(
    getSetting(SETTING_KEYS.ORDER_FINANCIAL_VISIBILITY),
  );
  const canViewFinancials = !appSettingsLoading && resolveOrderFinancialVisibility({
    baseAllowed: canViewOrderFinancials(currentUser),
    user: currentUser,
    matrix: financialVisibilityMatrix,
  });
  const legacyIsAdmin = useMemo(
    () => isLegacyAdminUser(currentUser, featureFlags.useBackendPermissions),
    [currentUser],
  );
  const canViewSettings = useMemo(
    () => canViewSettingsCategory(currentUser, featureFlags.useBackendPermissions, legacyIsAdmin),
    [currentUser, legacyIsAdmin],
  );
  const canViewNavigation = useCallback(
    (name: string) =>
      canViewNavigationResource(name, currentUser, featureFlags.useBackendPermissions, canViewFinancials) &&
      canViewResourceByRoleVisibility(name, currentRoleKey, roleVisibilityMatrix),
    [canViewFinancials, currentRoleKey, currentUser, roleVisibilityMatrix],
  );
  const menuConfig = useMemo(() => getSidebarMenuConfig(variant), [variant]);
  const noopNavigate = useCallback(() => {}, []);
  const noopSetCreateOpen = useCallback(() => {}, []);
  const sider = useSiderMenuItems({
    resources,
    pathname: '/',
    push: noopNavigate,
    categoryOrder: menuConfig.categoryOrder,
    categoryMap: menuConfig.categoryMap,
    resourceLabels: RESOURCE_LABELS,
    resourceIcons: {},
    canViewNavigation,
    canViewSettings,
    canCreateOrders: false,
    setIsCreateModalOpen: noopSetCreateOpen,
    crm: null,
    sidebarMenuOrder: sidebarMenuPreferences.settings,
  });

  if (appSettingsLoading || sidebarMenuPreferences.isLoading) {
    return (
      <div style={{ display: 'grid', minHeight: 160, placeItems: 'center' }}>
        <Spin />
      </div>
    );
  }

  return <Navigate to={sider.defaultRoute} replace />;
};
