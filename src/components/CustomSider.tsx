import React, { useMemo } from "react";
import { Layout as AntLayout, Menu, Collapse } from "antd";
import type { MenuProps } from "antd";
import { useResource, useNavigation } from "@refinedev/core";
import { useLocation } from "react-router-dom";

const { Panel } = Collapse;

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
  film_vendors: "Производители плёнок",
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
  film_vendors: "Справочники",
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
      label: ordersLabel,
      onClick: () => push(ordersRoute),
    },
  ];

  return (
    <AntLayout.Sider collapsible>
      {/* Заказы сверху */}
      <Menu
        mode="inline"
        selectedKeys={selectedKey === "orders_view" ? ["orders_view"] : []}
        items={ordersMenuItem}
        style={{ marginBottom: 8 }}
      />

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
            label: item.label,
            onClick: () => push(item.route),
          }));

          // Проверяем, выбран ли какой-то пункт в этой категории
          const isSelected = items.some((item) => item.name === selectedKey);

          return (
            <Panel
              header={category}
              key={category}
              style={{
                color: "white",
              }}
            >
              <Menu
                mode="inline"
                selectedKeys={isSelected ? [selectedKey] : []}
                items={categoryItems}
                style={{ border: "none" }}
              />
            </Panel>
          );
        })}
      </Collapse>

      <style>{`
        .sidebar-collapse .ant-collapse-header {
          color: white !important;
        }
        .sidebar-collapse .ant-collapse-header:hover {
          color: #e0e0e0 !important;
        }
        .sidebar-collapse .ant-collapse-expand-icon {
          color: white !important;
        }
      `}</style>
    </AntLayout.Sider>
  );
};

export default CustomSider;

