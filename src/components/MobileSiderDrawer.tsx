import React, { useCallback, useState } from "react";
import { Drawer, Menu, Button, Typography, Space } from "antd";
import { CloseOutlined, PlusOutlined, ContactsOutlined } from "@ant-design/icons";
import { useResource, useNavigation } from "@refinedev/core";
import { useLocation } from "react-router-dom";
import { OrderCreateModal } from "../pages/orders/components/OrderCreateModal";
import { authStorage } from "../utils/auth";
import { authSession } from "../api/authSession";
import { featureFlags } from "../config/featureFlags";
import { isLegacyAdminUser, canViewNavigationResource, canViewSettingsCategory } from "../utils/navigationPermissions";
import { canManageOrderContent } from "../utils/orderFinancialVisibility";
import { useOrderFinancialVisibility } from "../hooks/useOrderFinancialVisibility";
import { useSiderMenuItems } from "../utils/siderMenuItems";
import { bitrix24MenuConfig } from "../config/bitrix24";
import { useAppSettings, SETTING_KEYS } from "../hooks/useAppSettings";
import {
  canViewResourceByRoleVisibility,
  getCurrentUserRoleKey,
  normalizeRoleVisibilityMatrix,
} from "../utils/resourceVisibility";
import { SIDER_RESOURCE_ICONS } from "./siderResourceIcons";

const { Title } = Typography;

const CATEGORY_ORDER = [
  "Контрагенты",
  "Финансы",
  "Производство",
  "Материалы",
  "Данные",
  "Справочники",
  "Журналы",
  "Настройки",
] as const;

const CATEGORY_MAP: Record<string, string> = {
  clients: "Контрагенты",
  clients_analytics_view: "Контрагенты",
  suppliers: "Контрагенты",
  vendors: "Контрагенты",
  film_vendors: "Контрагенты",
  payments: "Финансы",
  payments_view: "Финансы",
  "orders-trash": "Данные",
  "mdf-work-board": "Производство",
  groups: "Производство",
  projects: "Производство",
  order_workshops: "Производство",
  workshops: "Производство",
  work_centers: "Производство",
  doweling_orders_view: "Производство",
  bazis: "Производство",
  "cut-jobs": "Производство",
  "bazis-cut-sets": "Производство",
  films: "Материалы",
  materials: "Материалы",
  sheet_material_types: "Материалы",
  employees: "Настройки",
  users: "Настройки",
  configuration: "Настройки",
  audit: "Журналы",
};

const RESOURCE_LABELS: Record<string, string> = {
  orders_view: "Заказы",
  calendar: "Календарь",
  'order-status-board': "Доски статусов",
  'mdf-work-board': "МДФ-работы",
  groups: "Группы",
  projects: "Проекты",
  clients: "Клиенты",
  payments: "Платежи",
  materials: "Материалы",
  configuration: "Конфигурация",
  sheet_material_types: "Листовые материалы",
  scan: "Сканер бирок",
};

export interface MobileSiderDrawerProps {
  open: boolean;
  onClose: () => void;
}

export const MobileSiderDrawer: React.FC<MobileSiderDrawerProps> = ({ open, onClose }) => {
  const { resources } = useResource();
  const { push } = useNavigation();
  const location = useLocation();
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const { getSetting } = useAppSettings();

  const currentUser = featureFlags.useBackendPermissions
    ? authSession.getUser()
    : authStorage.getUser();
  const { canViewFinancials } = useOrderFinancialVisibility(currentUser);
  const currentRoleKey = getCurrentUserRoleKey(currentUser);
  const roleVisibilityMatrix = normalizeRoleVisibilityMatrix(
    getSetting(SETTING_KEYS.RESOURCE_VISIBILITY_BY_ROLE),
  );
  const legacyIsAdmin = React.useMemo(
    () => isLegacyAdminUser(currentUser, featureFlags.useBackendPermissions),
    [currentUser, featureFlags.useBackendPermissions],
  );
  const canViewSettings = React.useMemo(
    () =>
      canViewSettingsCategory(currentUser, featureFlags.useBackendPermissions, legacyIsAdmin),
    [currentUser, legacyIsAdmin, featureFlags.useBackendPermissions],
  );
  const canCreateOrders = React.useMemo(
    () => canManageOrderContent("orders.create", currentUser, canViewFinancials),
    [canViewFinancials, currentUser, featureFlags.useBackendPermissions],
  );
  const canViewNavigation = useCallback(
    (name: string) =>
      canViewNavigationResource(name, currentUser, featureFlags.useBackendPermissions, canViewFinancials) &&
      canViewResourceByRoleVisibility(name, currentRoleKey, roleVisibilityMatrix),
    [canViewFinancials, currentRoleKey, currentUser, roleVisibilityMatrix],
  );

  const sider = useSiderMenuItems({
    resources,
    pathname: location.pathname,
    push: (route) => {
      push(route);
      onClose();
    },
    categoryOrder: CATEGORY_ORDER,
    categoryMap: CATEGORY_MAP,
    resourceLabels: RESOURCE_LABELS,
    resourceIcons: SIDER_RESOURCE_ICONS,
    canViewNavigation,
    canViewSettings,
    canCreateOrders,
    setIsCreateModalOpen,
    crm: bitrix24MenuConfig
      ? { ...bitrix24MenuConfig, icon: <ContactsOutlined /> }
      : null,
  });

  return (
    <>
      <Drawer
        title={
          <Space>
            <Title level={5} style={{ margin: 0 }}>ERP</Title>
          </Space>
        }
        placement="left"
        width={280}
        open={open}
        onClose={onClose}
        closeIcon={<CloseOutlined />}
        styles={{ body: { padding: 0 } }}
      >
        {canCreateOrders && (
          <div style={{ padding: "12px 16px" }}>
            <Button
              type="primary"
              icon={<PlusOutlined />}
              block
              onClick={() => {
                sider.handleNewOrder();
                onClose();
              }}
            >
              Создать заказ
            </Button>
          </div>
        )}

        <Menu
          mode="inline"
          selectedKeys={sider.selectedKey ? [sider.selectedKey] : []}
          items={[...sider.topMenuItems, ...sider.flatMenuItems]}
          style={{ borderRight: 0 }}
          onClick={onClose}
        />
      </Drawer>

      <OrderCreateModal open={isCreateModalOpen} onClose={() => setIsCreateModalOpen(false)} />
    </>
  );
};

export default MobileSiderDrawer;
