import React, { useMemo, useState } from "react";
import { Layout as AntLayout, Menu, Collapse, Button, Typography } from "antd";
import {
  PlusOutlined,
  FileTextOutlined,
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

const { Panel } = Collapse;
const { Title } = Typography;

// Карта иконок для ресурсов
const RESOURCE_ICONS: Record<string, React.ReactNode> = {
  orders_view: <FileTextOutlined />,
  clients: <UserOutlined />,
  suppliers: <ShopOutlined />,
  payments: <DollarOutlined />,
  films: <FileImageOutlined />,
  materials: <InboxOutlined />,
  order_resource_requirements: <ShoppingCartOutlined />,
  vendors: <ShopOutlined />,
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

// Карта иконок для категорий
const CATEGORY_ICONS: Record<string, React.ReactNode> = {
  "Контрагенты": <TeamOutlined />,
  "Финансы": <DollarOutlined />,
  "Материалы": <InboxOutlined />,
  "Закуп": <ShoppingCartOutlined />,
  "Справочники": <SettingOutlined />,
};

// Карта русских названий ресурсов из ru_table_name.md
const RESOURCE_LABELS: Record<string, string> = {
  orders_view: "Заказы",
  clients: "Клиенты",
  suppliers: "Поставщики",
  payments: "Платежи",
  films: "Плёнки",
  materials: "Материалы",
  order_resource_requirements: "Потребности заказов",
  vendors: "Производители",
  film_types: "Типы плёнок",
  units: "Единицы измерения",
  material_types: "Типы материалов",
  edge_types: "Типы обката",
  milling_types: "Типы фрезеровок",
  order_statuses: "Статусы заказов",
  payment_statuses: "Статусы оплат",
  production_statuses: "Статусы производства",
  requisition_statuses: "Статусы заявок на покупку",
  resource_requirements_statuses: "Статусы потребности заказов",
  workshops: "Цеха",
  work_centers: "Участки цехов",
  payment_types: "Типы оплаты",
  transaction_direction: "Типы направлений движений",
  material_transaction_types: "Типы движений материалов",
  employees: "Сотрудники",
  users: "Пользователи",
  movements_statuses: "Статусы движений",
  order_workshops: "Цеха заказов",
};

// Карта категорий из ru_table_name.md
const CATEGORY_MAP: Record<string, string> = {
  // Контрагенты
  clients: "Контрагенты",
  suppliers: "Контрагенты",

  // Финансы
  payments: "Финансы",

  // Материалы
  films: "Материалы",
  materials: "Материалы",

  // Закуп
  order_resource_requirements: "Закуп",

  // Справочники (все остальное)
  vendors: "Справочники",
  film_types: "Справочники",
  units: "Справочники",
  material_types: "Справочники",
  edge_types: "Справочники",
  milling_types: "Справочники",
  order_statuses: "Справочники",
  payment_statuses: "Справочники",
  production_statuses: "Справочники",
  requisition_statuses: "Справочники",
  resource_requirements_statuses: "Справочники",
  workshops: "Справочники",
  work_centers: "Справочники",
  payment_types: "Справочники",
  transaction_direction: "Справочники",
  material_transaction_types: "Справочники",
  employees: "Справочники",
  users: "Справочники",
  movements_statuses: "Справочники",
  order_workshops: "Справочники",
};

export const CustomSider: React.FC = () => {
  const { resources } = useResource();
  const { push } = useNavigation();
  const location = useLocation();
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);

  // Группируем ресурсы по категориям
  const categorizedResources = useMemo(() => {
    const categories: Record<string, Array<{ name: string; label: string; route: string }>> = {
      "Контрагенты": [],
      "Финансы": [],
      "Материалы": [],
      "Закуп": [],
      "Справочники": [],
    };

    resources.forEach((resource) => {
      // Пропускаем orders_view - он будет отдельным пунктом
      if (resource.name === "orders_view") return;

      const category = CATEGORY_MAP[resource.name] || "Справочники";
      const label = RESOURCE_LABELS[resource.name] || resource.meta?.label || resource.name;

      // Получаем маршрут из resource.list или формируем из meta
      let route = "";
      if (typeof resource.list === "string") {
        route = resource.list;
      } else if (resource.meta?.route) {
        route = resource.meta.route;
      }

      if (route) {
        categories[category].push({
          name: resource.name,
          label,
          route,
        });
      }
    });

    // Сортируем внутри категорий по алфавиту
    Object.keys(categories).forEach((cat) => {
      categories[cat].sort((a, b) => a.label.localeCompare(b.label, "ru"));
    });

    return categories;
  }, [resources]);

  // Определяем выбранный пункт меню
  const selectedKey = useMemo(() => {
    const resource = resources.find((r) => {
      if (typeof r.list === "string") {
        return location.pathname.startsWith(r.list);
      }
      return false;
    });
    return resource?.name || "";
  }, [location.pathname, resources]);

  // Orders - отдельный пункт меню сверху
  const ordersResource = resources.find((r) => r.name === "orders_view");
  const ordersRoute = typeof ordersResource?.list === "string" ? ordersResource.list : "/orders";
  const ordersLabel = RESOURCE_LABELS["orders_view"] || "Заказы";

  const ordersMenuItem: MenuProps["items"] = [
    {
      key: "orders_view",
      icon: RESOURCE_ICONS["orders_view"],
      label: ordersLabel,
      onClick: () => push(ordersRoute),
    },
  ];

  const handleNewOrder = () => {
    // Сначала переходим на страницу списка заказов
    push(ordersRoute);
    // Затем открываем модалку
    setIsCreateModalOpen(true);
  };

  return (
    <AntLayout.Sider collapsible>
      {/* Заголовок приложения */}
      <div
        style={{
          padding: "16px",
          textAlign: "center",
          background: "#001529",
          borderBottom: "1px solid rgba(255, 255, 255, 0.1)",
        }}
      >
        <Title
          level={4}
          style={{
            color: "white",
            margin: 0,
            fontWeight: 600,
          }}
        >
          ERP v.0.5
        </Title>
      </div>

      {/* Область меню с темно-серым фоном */}
      <div
        style={{
          background: "#37474F",
          minHeight: "calc(100vh - 200px)",
          padding: "8px 0",
        }}
      >
        {/* Заказы */}
        <Menu
          mode="inline"
          selectedKeys={selectedKey === "orders_view" ? ["orders_view"] : []}
          items={ordersMenuItem}
          style={{
            background: "transparent",
            border: "none",
            marginBottom: 0,
            color: "#E0E0E0",
          }}
          className="orders-menu"
        />

        {/* Кнопка "Новый Заказ" */}
        <div style={{ padding: "8px 16px" }}>
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={handleNewOrder}
            block
            style={{ marginBottom: 8 }}
          >
            Новый Заказ
          </Button>
        </div>

        {/* Группированные категории */}
        <Collapse
          accordion
          ghost
          defaultActiveKey={undefined}
          style={{ background: "transparent", border: "none" }}
          className="sidebar-collapse"
        >
          {Object.entries(categorizedResources).map(([category, items]) => {
            // Пропускаем пустые категории
            if (items.length === 0) return null;

            // Создаем пункты меню для категории
            const categoryItems: MenuProps["items"] = items.map((item) => ({
              key: item.name,
              icon: RESOURCE_ICONS[item.name],
              label: item.label,
              onClick: () => push(item.route),
            }));

            // Проверяем, выбран ли какой-то пункт в этой категории
            const isSelected = items.some((item) => item.name === selectedKey);

            return (
              <Panel
                header={
                  <span>
                    <span style={{ marginRight: '8px' }}>{CATEGORY_ICONS[category]}</span>
                    {category}
                  </span>
                }
                key={category}
                style={{
                  color: "#E0E0E0",
                }}
              >
                <Menu
                  mode="inline"
                  selectedKeys={isSelected ? [selectedKey] : []}
                  items={categoryItems}
                  style={{
                    border: "none",
                    background: "transparent",
                    fontSize: "0.85em", // Уменьшение на 15%
                  }}
                />
              </Panel>
            );
          })}
        </Collapse>
      </div>

      {/* Модалка создания заказа */}
      <OrderCreateModal
        open={isCreateModalOpen}
        onClose={() => setIsCreateModalOpen(false)}
      />

      <style>{`
        /* Стили для меню Заказы */
        .orders-menu .ant-menu-item {
          color: #E0E0E0 !important;
          font-size: 1em !important;
          letter-spacing: 1px !important;
        }
        .orders-menu .ant-menu-item:hover {
          color: #90CAF9 !important;
        }
        .orders-menu .ant-menu-item-selected {
          background-color: rgba(144, 202, 249, 0.2) !important;
          color: #90CAF9 !important;
        }

        /* Стили для аккордеона */
        .sidebar-collapse .ant-collapse-header {
          color: #E0E0E0 !important;
          font-weight: 500;
          letter-spacing: 1px !important;
        }
        .sidebar-collapse .ant-collapse-header:hover {
          color: #90CAF9 !important;
        }
        .sidebar-collapse .ant-collapse-expand-icon {
          color: #E0E0E0 !important;
        }
        .sidebar-collapse .ant-menu-item {
          font-size: 0.85em; /* Уменьшение на 15% */
          color: #E0E0E0 !important;
          letter-spacing: 1px !important;
        }
        .sidebar-collapse .ant-menu-item:hover {
          color: #90CAF9 !important;
        }
        .sidebar-collapse .ant-menu-item-selected {
          background-color: rgba(144, 202, 249, 0.2) !important;
          color: #90CAF9 !important;
        }
        .sidebar-collapse .ant-collapse-content {
          background: transparent !important;
        }
      `}</style>
    </AntLayout.Sider>
  );
};

export default CustomSider;

