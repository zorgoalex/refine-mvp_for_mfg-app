import React, { useMemo, useState } from "react";
import { Layout as AntLayout, Menu, Collapse, Button, Typography } from "antd";
import {
  PlusOutlined,
  FileTextOutlined,
  CalendarOutlined,
  UserOutlined,
  ShopOutlined,
  DollarOutlined,
  FileImageOutlined,
  InboxOutlined,
  ShoppingCartOutlined,
  TagsOutlined,
  CalculatorOutlined,
  AppstoreOutlined,
  BorderOutlined,
  ToolOutlined,
  CheckCircleOutlined,
  DollarCircleOutlined,
  SyncOutlined,
  FileSearchOutlined,
  CheckSquareOutlined,
  HomeOutlined,
  ApartmentOutlined,
  CreditCardOutlined,
  SwapOutlined,
  TransactionOutlined,
  IdcardOutlined,
  ArrowsAltOutlined,
  EnvironmentOutlined,
  TeamOutlined,
  SettingOutlined,
} from "@ant-design/icons";
import type { MenuProps } from "antd";
import { useResource, useNavigation } from "@refinedev/core";
import { useLocation } from "react-router-dom";
import { OrderCreateModal } from "../pages/orders/components/OrderCreateModal";
import { authStorage } from "../utils/auth";

const { Panel } = Collapse;
const { Title } = Typography;

const CATEGORY_ORDER = [
  "Контрагенты",
  "Финансы",
  "Производство",
  "Материалы",
  "Справочники",
  "Настройки",
];

const RESOURCE_ICONS: Record<string, React.ReactNode> = {
  orders_view: <FileTextOutlined />,
  calendar: <CalendarOutlined />,
  clients: <UserOutlined />,
  suppliers: <ShopOutlined />,
  vendors: <ShopOutlined />,
  film_vendors: <ShopOutlined />,
  payments: <DollarOutlined />,
  films: <FileImageOutlined />,
  materials: <InboxOutlined />,
  order_resource_requirements: <ShoppingCartOutlined />,
  film_types: <TagsOutlined />,
  units: <CalculatorOutlined />,
  material_types: <AppstoreOutlined />,
  edge_types: <BorderOutlined />,
  milling_types: <ToolOutlined />,
  order_statuses: <CheckCircleOutlined />,
  payment_statuses: <DollarCircleOutlined />,
  production_statuses: <SyncOutlined />,
  requisition_statuses: <FileSearchOutlined />,
  resource_requirements_statuses: <CheckSquareOutlined />,
  workshops: <HomeOutlined />,
  work_centers: <ApartmentOutlined />,
  payment_types: <CreditCardOutlined />,
  transaction_direction: <SwapOutlined />,
  material_transaction_types: <TransactionOutlined />,
  employees: <IdcardOutlined />,
  users: <UserOutlined />,
  movements_statuses: <ArrowsAltOutlined />,
  order_workshops: <EnvironmentOutlined />,
};

const CATEGORY_ICONS: Record<string, React.ReactNode> = {
  "Контрагенты": <TeamOutlined />,
  "Финансы": <DollarOutlined />,
  "Производство": <ToolOutlined />,
  "Материалы": <InboxOutlined />,
  "Справочники": <SettingOutlined />,
  "Настройки": <SettingOutlined />,
};

const RESOURCE_LABELS: Record<string, string> = {
  orders_view: "Заказы",
  calendar: "Календарь",
  clients: "Клиенты",
  suppliers: "Поставщики",
  vendors: "Производители",
  film_vendors: "Производители плёнки",
  payments: "Платежи",
  films: "Пленки",
  materials: "Материалы",
  order_resource_requirements: "Потребности заказов",
  film_types: "Типы плёнки",
  units: "Ед. измерения",
  material_types: "Типы материалов",
  edge_types: "Типы кромок",
  milling_types: "Типы фрезеровки",
  order_statuses: "Статусы заказов",
  payment_statuses: "Статусы оплат",
  production_statuses: "Статусы производства",
  requisition_statuses: "Статусы заявок",
  resource_requirements_statuses: "Статусы потребностей",
  workshops: "Цеха",
  work_centers: "Участки цехов",
  payment_types: "Типы оплат",
  transaction_direction: "Направления движения",
  material_transaction_types: "Типы движений материалов",
  employees: "Сотрудники",
  users: "Пользователи",
  movements_statuses: "Статусы движений",
  order_workshops: "Цеха заказа",
};

const CATEGORY_MAP: Record<string, string> = {
  clients: "Контрагенты",
  suppliers: "Контрагенты",
  vendors: "Контрагенты",
  film_vendors: "Контрагенты",
  payments: "Финансы",
  order_workshops: "Производство",
  workshops: "Производство",
  work_centers: "Производство",
  films: "Материалы",
  materials: "Материалы",
  employees: "Настройки",
  users: "Настройки",
};

export const CustomSider: React.FC = () => {
  const { resources } = useResource();
  const { push } = useNavigation();
  const location = useLocation();
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  const currentUser = useMemo(() => authStorage.getUser(), []);
  const isAdmin = useMemo(() => currentUser?.role_id === 1 || currentUser?.role === "admin", [currentUser]);

  const categorizedResources = useMemo(() => {
    const categories: Record<string, Array<{ name: string; label: string; route: string }>> = CATEGORY_ORDER.reduce(
      (acc, cat) => ({ ...acc, [cat]: [] as Array<{ name: string; label: string; route: string }> }),
      {} as Record<string, Array<{ name: string; label: string; route: string }>>,
    );

    resources.forEach((resource) => {
      if (resource.name === "orders_view" || resource.name === "calendar") return;
      const category = CATEGORY_MAP[resource.name] || "Справочники";
      const label = RESOURCE_LABELS[resource.name] || resource.meta?.label || resource.name;
      let route = "";
      if (typeof resource.list === "string") {
        route = resource.list;
      } else if (resource.meta?.route) {
        route = resource.meta.route;
      }
      if (route) {
        categories[category].push({ name: resource.name, label, route });
      }
    });

    CATEGORY_ORDER.forEach((cat) => {
      categories[cat].sort((a, b) => a.label.localeCompare(b.label, "ru"));
    });

    return categories;
  }, [resources, isAdmin]);

  const selectedKey = useMemo(() => {
    const resource = resources.find((r) => typeof r.list === "string" && location.pathname.startsWith(r.list as string));
    return resource?.name || "";
  }, [location.pathname, resources]);

  const ordersResource = resources.find((r) => r.name === "orders_view");
  const ordersRoute = typeof ordersResource?.list === "string" ? ordersResource.list : "/orders";
  const ordersLabel = RESOURCE_LABELS["orders_view"] || "Заказы";

  const calendarResource = resources.find((r) => r.name === "calendar");
  const calendarRoute = typeof calendarResource?.list === "string" ? calendarResource.list : "/calendar";
  const calendarLabel = RESOURCE_LABELS["calendar"] || "Календарь";

  const topMenuItems: MenuProps["items"] = [
    { key: "orders_view", icon: RESOURCE_ICONS["orders_view"], label: ordersLabel, onClick: () => push(ordersRoute) },
    { key: "calendar", icon: RESOURCE_ICONS["calendar"], label: calendarLabel, onClick: () => push(calendarRoute) },
  ];

  const handleNewOrder = () => {
    push(ordersRoute);
    setIsCreateModalOpen(true);
  };

  const flatMenuItems: MenuProps["items"] = CATEGORY_ORDER.flatMap((category) => {
    if (category === "Системные" && !isAdmin) return [];
    const items = categorizedResources[category];
    if (!items || items.length === 0) return [];
    return items.map((item) => ({
      key: item.name,
      icon: RESOURCE_ICONS[item.name],
      label: item.label,
      onClick: () => push(item.route),
    }));
  });

  return (
    <AntLayout.Sider collapsible collapsed={collapsed} onCollapse={(val) => setCollapsed(val)}>
      <div
        style={{
          padding: "16px",
          textAlign: "center",
          background: "#001529",
          borderBottom: "1px solid rgba(255, 255, 255, 0.1)",
        }}
      >
        <Title level={4} style={{ color: "white", margin: 0, fontWeight: 600 }}>
          {collapsed ? (
            <span>ERP</span>
          ) : (
            <>
              <span>ERP Zhihaz </span>
              <span style={{ fontSize: "0.8em", fontWeight: 400 }}>v.0.5</span>
            </>
          )}
        </Title>
      </div>

      <div
        style={{
          background: "#37474F",
          height: "calc(100vh - 120px)",
          overflowY: "auto",
          overflowX: "hidden",
          padding: "8px 0",
        }}
      >
        <Menu
          mode="inline"
          inlineCollapsed={collapsed}
          selectedKeys={selectedKey === "orders_view" || selectedKey === "calendar" ? [selectedKey] : []}
          items={topMenuItems}
          style={{ background: "transparent", border: "none", marginBottom: 0, color: "#E0E0E0" }}
          className="orders-menu"
        />

        <div style={{ padding: "8px 16px", marginTop: "72px" }}>
          <Button type="primary" icon={<PlusOutlined />} onClick={handleNewOrder} block style={{ marginBottom: 8 }}>
            {!collapsed && "Создать заказ"}
          </Button>
        </div>

        {collapsed ? (
          <Menu
            mode="inline"
            inlineCollapsed={collapsed}
            selectedKeys={selectedKey ? [selectedKey] : []}
            items={flatMenuItems}
            style={{ border: "none", background: "transparent", fontSize: "0.98em" }}
          />
        ) : (
          <Collapse accordion ghost defaultActiveKey={undefined} style={{ background: "transparent", border: "none" }} className="sidebar-collapse">
            {CATEGORY_ORDER.map((category) => {
              const items = categorizedResources[category];
              if (!items || items.length === 0) return null;
              if (category === "Системные" && !isAdmin) return null;

              const categoryItems: MenuProps["items"] = items.map((item) => ({
                key: item.name,
                icon: RESOURCE_ICONS[item.name],
                label: item.label,
                onClick: () => push(item.route),
              }));

              const isSelected = items.some((item) => item.name === selectedKey);

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
                    selectedKeys={isSelected ? [selectedKey] : []}
                    items={categoryItems}
                    style={{ border: "none", background: "transparent", fontSize: "0.98em" }}
                  />
                </Panel>
              );
            })}
          </Collapse>
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
        .sidebar-collapse .ant-menu-item { font-size: 0.98em; color: #E0E0E0 !important; letter-spacing: 1px !important; }
        .sidebar-collapse .ant-menu-item:hover { color: #90CAF9 !important; }
        .sidebar-collapse .ant-menu-item-selected { background-color: rgba(144, 202, 249, 0.2) !important; color: #90CAF9 !important; }
        .sidebar-collapse .ant-collapse-content { background: transparent !important; }
      `}</style>
    </AntLayout.Sider>
  );
};

export default CustomSider;
