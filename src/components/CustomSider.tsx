import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Layout as AntLayout, Menu, Collapse, Button, Typography, Tooltip } from "antd";
import {
  PlusOutlined,
  DollarOutlined,
  InboxOutlined,
  ToolOutlined,
  TeamOutlined,
  SettingOutlined,
  ContactsOutlined,
} from "@ant-design/icons";
import type { MenuProps } from "antd";
import { useResource, useNavigation } from "@refinedev/core";
import { useLocation } from "react-router-dom";
import { OrderCreateModal } from "../pages/orders/components/OrderCreateModal";
import { authStorage } from "../utils/auth";
import { authSession } from "../api/authSession";
import { featureFlags } from "../config/featureFlags";
import {
  canViewNavigationResource,
  canViewSettingsCategory,
  isLegacyAdminUser,
} from "../utils/navigationPermissions";
import { can } from "../utils/permissions";
import { useSiderMenuItems } from "../utils/siderMenuItems";
import {
  bitrix24MenuConfig,
  ensureBitrix24ResourceHints,
} from "../config/bitrix24";
import { RESOURCE_LABELS } from "../utils/tabLabels";
import { useAppSettings, SETTING_KEYS } from "../hooks/useAppSettings";
import { useSidebarMenuPreferences } from "../hooks/useSidebarMenuPreferences";
import {
  canViewResourceByRoleVisibility,
  getCurrentUserRoleKey,
  normalizeRoleVisibilityMatrix,
} from "../utils/resourceVisibility";
import { APP_VERSION } from "../version";
import { SidebarMenuSettingsButton } from "./SidebarMenuSettingsButton";
import { SIDER_RESOURCE_ICONS } from "./siderResourceIcons";

const { Panel } = Collapse;
const { Title } = Typography;

const menuLabelWithTooltip = (label: string) => (
  <Tooltip title={label} placement="right" mouseEnterDelay={0.35}>
    <span className="sidebar-menu-label">{label}</span>
  </Tooltip>
);

const CATEGORY_ORDER = [
  "Контрагенты",
  "Финансы",
  "Производство",
  "Материалы",
  "Справочники",
  "Настройки",
] as const;

const CATEGORY_ICONS: Record<string, React.ReactNode> = {
  "Контрагенты": <TeamOutlined />,
  "Финансы": <DollarOutlined />,
  "Производство": <ToolOutlined />,
  "Материалы": <InboxOutlined />,
  "Справочники": <SettingOutlined />,
  "Настройки": <SettingOutlined />,
};

const CATEGORY_MAP: Record<string, string> = {
  clients: "Контрагенты",
  clients_analytics_view: "Контрагенты",
  suppliers: "Контрагенты",
  vendors: "Контрагенты",
  film_vendors: "Контрагенты",
  payments: "Финансы",
  payments_view: "Финансы",
  "orders-trash": "Производство",
  groups: "Производство",
  projects: "Производство",
  order_workshops: "Производство",
  workshops: "Производство",
  work_centers: "Производство",
  doweling_orders_view: "Производство",
  bazis: "Производство",
  "cut-jobs": "Производство",
  "bazis-cut-sets": "Производство",
  scan: "Производство",
  films: "Материалы",
  materials: "Материалы",
  sheet_material_types: "Материалы",
  employees: "Настройки",
  users: "Настройки",
  configuration: "Настройки",
  audit: "Настройки",
};

export const CustomSider: React.FC = () => {
  const { resources } = useResource();
  const { push } = useNavigation();
  const location = useLocation();
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(true);
  const { getSetting } = useAppSettings();
  const sidebarMenuPreferences = useSidebarMenuPreferences();

  // Warm DNS/TLS to Bitrix24 while the user works in ERP.
  useEffect(() => {
    if (bitrix24MenuConfig) ensureBitrix24ResourceHints(bitrix24MenuConfig.url);
  }, []);

  const currentUser = featureFlags.useBackendPermissions ? authSession.getUser() : authStorage.getUser();
  const currentRoleKey = getCurrentUserRoleKey(currentUser);
  const roleVisibilityMatrix = normalizeRoleVisibilityMatrix(
    getSetting(SETTING_KEYS.RESOURCE_VISIBILITY_BY_ROLE),
  );
  const legacyIsAdmin = useMemo(
    () => isLegacyAdminUser(currentUser, featureFlags.useBackendPermissions),
    [currentUser, featureFlags.useBackendPermissions],
  );
  const canViewSettings = useMemo(
    () =>
      canViewSettingsCategory(
        currentUser,
        featureFlags.useBackendPermissions,
        legacyIsAdmin,
      ),
    [currentUser, legacyIsAdmin, featureFlags.useBackendPermissions],
  );
  const canCreateOrders = useMemo(
    () => !featureFlags.useBackendPermissions || can("orders.create", currentUser),
    [currentUser, featureFlags.useBackendPermissions],
  );
  const canViewNavigation = useCallback(
    (name: string) =>
      canViewNavigationResource(name, currentUser, featureFlags.useBackendPermissions) &&
      canViewResourceByRoleVisibility(name, currentRoleKey, roleVisibilityMatrix),
    [currentRoleKey, currentUser, roleVisibilityMatrix],
  );

  const sider = useSiderMenuItems({
    resources,
    pathname: location.pathname,
    push,
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
    sidebarMenuOrder: sidebarMenuPreferences.settings,
  });

  return (
    <AntLayout.Sider collapsible collapsed={collapsed} onCollapse={(val) => setCollapsed(val)} width={195} collapsedWidth={48}>
      <div
        style={{
          padding: "8px 4px",
          textAlign: "center",
          background: "#001529",
          borderBottom: "1px solid rgba(255, 255, 255, 0.1)",
        }}
      >
        <Title level={5} style={{ color: "white", margin: 0, fontWeight: 600, fontSize: collapsed ? 11 : 20 }}>
          {collapsed ? (
            <span>ERP</span>
          ) : (
            <>
              <span>ERP </span>
              <span style={{ fontSize: "0.75em", fontWeight: 400 }}>v{APP_VERSION}</span>
            </>
          )}
        </Title>
      </div>

      <div
        style={{
          background: "#37474F",
          height: "calc(100vh - 120px)",
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
        }}
      >
        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: "auto",
            overflowX: "hidden",
            padding: "8px 0",
          }}
        >
          <Menu
            mode="inline"
            selectedKeys={
              sider.selectedKey === "orders_view" ||
              sider.selectedKey === "calendar" ||
              sider.selectedKey === "order-status-board"
                ? [sider.selectedKey]
                : []
            }
            items={sider.topMenuItems}
            style={{ background: "transparent", border: "none", marginBottom: 0, color: "#E0E0E0" }}
            className="orders-menu"
          />

          {canCreateOrders && (
            <div style={{ padding: collapsed ? "8px 4px" : "8px 16px", marginTop: "72px", textAlign: "center" }}>
              <Button
                type="primary"
                icon={<PlusOutlined />}
                onClick={sider.handleNewOrder}
                block={!collapsed}
                style={{ marginBottom: 8 }}
                title={collapsed ? "Создать заказ" : undefined}
              >
                {!collapsed && "Создать заказ"}
              </Button>
              {!collapsed && (
                <SidebarMenuSettingsButton
                  topItems={sider.topMenuOrderItems}
                  categorizedResources={sider.categorizedResources}
                  defaults={sider.menuOrderDefaults}
                  settings={sider.menuOrderSettings}
                  onChange={sidebarMenuPreferences.saveSettings}
                  buttonProps={{
                    size: "small",
                    shape: "circle",
                    style: { color: "#E0E0E0", borderColor: "rgba(255, 255, 255, 0.24)", background: "transparent" },
                  }}
                  tooltipPlacement="right"
                />
              )}
            </div>
          )}

          {!canCreateOrders && !collapsed && (
            <div style={{ padding: "8px 16px", marginTop: "72px", textAlign: "center" }}>
              <SidebarMenuSettingsButton
                topItems={sider.topMenuOrderItems}
                categorizedResources={sider.categorizedResources}
                defaults={sider.menuOrderDefaults}
                settings={sider.menuOrderSettings}
                onChange={sidebarMenuPreferences.saveSettings}
                buttonProps={{
                  size: "small",
                  shape: "circle",
                  style: { color: "#E0E0E0", borderColor: "rgba(255, 255, 255, 0.24)", background: "transparent" },
                }}
                tooltipPlacement="right"
              />
            </div>
          )}

          {collapsed ? (
            <Menu
              mode="inline"
              selectedKeys={sider.selectedKey ? [sider.selectedKey] : []}
              items={sider.flatMenuItems}
              style={{ border: "none", background: "transparent", fontSize: "0.98em" }}
            />
          ) : (
            <Collapse accordion ghost defaultActiveKey={undefined} style={{ background: "transparent", border: "none" }} className="sidebar-collapse">
              {sider.categoryOrder.map((category) => {
                const items = sider.categorizedResources[category];
                if (!items || items.length === 0) return null;
                if (category === "Настройки" && !canViewSettings) return null;

                const categoryItems: MenuProps["items"] = items.map((item) => ({
                  key: item.name,
                  icon: SIDER_RESOURCE_ICONS[item.name],
                  label: menuLabelWithTooltip(item.label),
                  title: item.label,
                  onClick: () => push(item.route),
                }));

                const isSelected = items.some((item) => item.name === sider.selectedKey);

                return (
                  <Panel
                    header={
                      <span>
                        <span style={{ marginRight: "8px" }}>{CATEGORY_ICONS[category]}</span>
                        {category}
                      </span>
                    }
                    key={category}
                    style={{ color: "#E0E0E0" }}
                  >
                    <Menu
                      mode="inline"
                      selectedKeys={isSelected ? [sider.selectedKey] : []}
                      items={categoryItems}
                      style={{ border: "none", background: "transparent", fontSize: "0.98em" }}
                    />
                  </Panel>
                );
              })}
            </Collapse>
          )}
        </div>

        {collapsed && (
          <div style={{ padding: "8px 4px 10px", borderTop: "1px solid rgba(255, 255, 255, 0.1)", textAlign: "center" }}>
            <SidebarMenuSettingsButton
              topItems={sider.topMenuOrderItems}
              categorizedResources={sider.categorizedResources}
              defaults={sider.menuOrderDefaults}
              settings={sider.menuOrderSettings}
              onChange={sidebarMenuPreferences.saveSettings}
              buttonProps={{
                size: "small",
                shape: "circle",
                type: "text",
                style: { color: "#E0E0E0" },
              }}
              tooltipPlacement="right"
            />
          </div>
        )}
      </div>

      <OrderCreateModal open={isCreateModalOpen} onClose={() => setIsCreateModalOpen(false)} />

      <style>{`
        .ant-layout-sider ::-webkit-scrollbar { width: 6px; }
        .ant-layout-sider ::-webkit-scrollbar-track { background: #263238; }
        .ant-layout-sider ::-webkit-scrollbar-thumb { background: #546E7A; border-radius: 3px; }
        .ant-layout-sider ::-webkit-scrollbar-thumb:hover { background: #607D8B; }

        .orders-menu .ant-menu-item { color: #E0E0E0 !important; font-size: 14px !important; font-weight: 500; letter-spacing: 1px !important; }
        .orders-menu .ant-menu-item:hover { color: #90CAF9 !important; }
        .orders-menu .ant-menu-item-selected { background-color: rgba(144, 202, 249, 0.2) !important; color: #90CAF9 !important; }

        .sidebar-collapse .ant-collapse-header { color: #E0E0E0 !important; font-weight: 500; letter-spacing: 1px !important; }
        .sidebar-collapse .ant-collapse-header:hover { color: #90CAF9 !important; }
        .sidebar-collapse .ant-collapse-expand-icon { color: #E0E0E0 !important; }
        .sidebar-collapse .ant-menu-item {
          height: auto !important;
          min-height: 40px;
          padding-top: 6px !important;
          padding-bottom: 6px !important;
          font-size: 0.64em;
          line-height: 1.25 !important;
          color: #E0E0E0 !important;
          letter-spacing: 1px !important;
          white-space: normal;
        }
        .sidebar-collapse .ant-menu-title-content { overflow: visible; white-space: normal; }
        .sidebar-menu-label {
          display: block;
          overflow: visible;
          text-overflow: clip;
          white-space: normal;
          overflow-wrap: normal;
          word-break: normal;
          text-wrap: pretty;
        }
        .sidebar-collapse .ant-menu-item:hover { color: #90CAF9 !important; }
        .sidebar-collapse .ant-menu-item-selected { background-color: rgba(144, 202, 249, 0.2) !important; color: #90CAF9 !important; }
        .sidebar-collapse .ant-collapse-content { background: transparent !important; }
      `}</style>
    </AntLayout.Sider>
  );
};

export default CustomSider;
