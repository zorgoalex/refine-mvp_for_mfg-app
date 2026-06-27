import { Refine, Authenticated } from "@refinedev/core";
import { RefineKbar, RefineKbarProvider } from "@refinedev/kbar";
import { WorkspaceLayout } from "./components/workspace/WorkspaceLayout";
import routerProvider, { CatchAllNavigate, NavigateToResource } from "@refinedev/react-router-v6";
import { BrowserRouter, Route, Routes, Outlet } from "react-router-dom";
import { ConfigProvider, notification, Spin, theme as antdTheme } from "antd";
import { useEffect, Suspense, lazy } from "react";
import ruRU from 'antd/locale/ru_RU';
import "@refinedev/antd/dist/reset.css";
import "./styles/app.css";
import { createNotificationProvider } from "./providers/notificationProvider";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { LoginPage } from "./pages/login";
import { dataProvider } from "./utils/dataProvider";
import { authProvider } from "./authProvider";
import { i18nProvider } from "./utils/i18nProvider";
import { featureFlags } from "./config/featureFlags";
import { AppThemeProvider, useAppTheme } from "./theme/ThemeProvider";

const OrderShow = lazy(async () => ({ default: (await import("./pages/orders/show")).OrderShow }));
const OrderEdit = lazy(async () => ({ default: (await import("./pages/orders/edit")).OrderEdit }));
const CalendarList = lazy(async () => ({ default: (await import("./pages/calendar")).CalendarList }));
const CutPage = lazy(async () => ({ default: (await import("./pages/cut/CutPage")).CutPage }));
const ProjectsPage = lazy(async () => ({ default: (await import("./pages/projects/ProjectsPage")).ProjectsPage }));
const DowelOrderEdit = lazy(async () => ({ default: (await import("./pages/doweling_orders/edit")).DowelOrderEdit }));
const DowelOrderShow = lazy(async () => ({ default: (await import("./pages/doweling_orders/show")).DowelOrderShow }));
const ConfigurationPage = lazy(async () => ({ default: (await import("./pages/configuration")).ConfigurationPage }));
const ProfilePage = lazy(async () => ({ default: (await import("./pages/profile")).ProfilePage }));

// Route-level code splitting: every page component is lazy-loaded so the root
// bundle ships only shell/providers/login. The existing <Suspense> around
// <Routes> covers all of these. Pages are named exports, so each lazy() adapts
// the named export to the default export React.lazy requires.
const OrderList = lazy(async () => ({ default: (await import("./pages/orders/list")).OrderList }));
const DowelOrderList = lazy(async () => ({ default: (await import("./pages/doweling_orders/list")).DowelOrderList }));

const MaterialList = lazy(async () => ({ default: (await import("./pages/materials/list")).MaterialList }));
const MaterialCreate = lazy(async () => ({ default: (await import("./pages/materials/create")).MaterialCreate }));
const MaterialEdit = lazy(async () => ({ default: (await import("./pages/materials/edit")).MaterialEdit }));
const MaterialShow = lazy(async () => ({ default: (await import("./pages/materials/show")).MaterialShow }));

const MillingTypeList = lazy(async () => ({ default: (await import("./pages/milling_types/list")).MillingTypeList }));
const MillingTypeCreate = lazy(async () => ({ default: (await import("./pages/milling_types/create")).MillingTypeCreate }));
const MillingTypeEdit = lazy(async () => ({ default: (await import("./pages/milling_types/edit")).MillingTypeEdit }));
const MillingTypeShow = lazy(async () => ({ default: (await import("./pages/milling_types/show")).MillingTypeShow }));

const FilmList = lazy(async () => ({ default: (await import("./pages/films/list")).FilmList }));
const FilmCreate = lazy(async () => ({ default: (await import("./pages/films/create")).FilmCreate }));
const FilmEdit = lazy(async () => ({ default: (await import("./pages/films/edit")).FilmEdit }));
const FilmShow = lazy(async () => ({ default: (await import("./pages/films/show")).FilmShow }));

const ClientList = lazy(async () => ({ default: (await import("./pages/clients/list")).ClientList }));
const ClientCreate = lazy(async () => ({ default: (await import("./pages/clients/create")).ClientCreate }));
const ClientEdit = lazy(async () => ({ default: (await import("./pages/clients/edit")).ClientEdit }));
const ClientShow = lazy(async () => ({ default: (await import("./pages/clients/show")).ClientShow }));

const EdgeTypeList = lazy(async () => ({ default: (await import("./pages/edge_types/list")).EdgeTypeList }));
const EdgeTypeCreate = lazy(async () => ({ default: (await import("./pages/edge_types/create")).EdgeTypeCreate }));
const EdgeTypeEdit = lazy(async () => ({ default: (await import("./pages/edge_types/edit")).EdgeTypeEdit }));
const EdgeTypeShow = lazy(async () => ({ default: (await import("./pages/edge_types/show")).EdgeTypeShow }));

const VendorList = lazy(async () => ({ default: (await import("./pages/vendors/list")).VendorList }));
const VendorCreate = lazy(async () => ({ default: (await import("./pages/vendors/create")).VendorCreate }));
const VendorEdit = lazy(async () => ({ default: (await import("./pages/vendors/edit")).VendorEdit }));
const VendorShow = lazy(async () => ({ default: (await import("./pages/vendors/show")).VendorShow }));

const SupplierList = lazy(async () => ({ default: (await import("./pages/suppliers/list")).SupplierList }));
const SupplierCreate = lazy(async () => ({ default: (await import("./pages/suppliers/create")).SupplierCreate }));
const SupplierEdit = lazy(async () => ({ default: (await import("./pages/suppliers/edit")).SupplierEdit }));
const SupplierShow = lazy(async () => ({ default: (await import("./pages/suppliers/show")).SupplierShow }));

const FilmTypeList = lazy(async () => ({ default: (await import("./pages/film_types/list")).FilmTypeList }));
const FilmTypeCreate = lazy(async () => ({ default: (await import("./pages/film_types/create")).FilmTypeCreate }));
const FilmTypeEdit = lazy(async () => ({ default: (await import("./pages/film_types/edit")).FilmTypeEdit }));
const FilmTypeShow = lazy(async () => ({ default: (await import("./pages/film_types/show")).FilmTypeShow }));

const MaterialTypeList = lazy(async () => ({ default: (await import("./pages/material_types/list")).MaterialTypeList }));
const MaterialTypeCreate = lazy(async () => ({ default: (await import("./pages/material_types/create")).MaterialTypeCreate }));
const MaterialTypeEdit = lazy(async () => ({ default: (await import("./pages/material_types/edit")).MaterialTypeEdit }));
const MaterialTypeShow = lazy(async () => ({ default: (await import("./pages/material_types/show")).MaterialTypeShow }));

const OrderStatusList = lazy(async () => ({ default: (await import("./pages/order_statuses/list")).OrderStatusList }));
const OrderStatusCreate = lazy(async () => ({ default: (await import("./pages/order_statuses/create")).OrderStatusCreate }));
const OrderStatusEdit = lazy(async () => ({ default: (await import("./pages/order_statuses/edit")).OrderStatusEdit }));
const OrderStatusShow = lazy(async () => ({ default: (await import("./pages/order_statuses/show")).OrderStatusShow }));

const PaymentStatusList = lazy(async () => ({ default: (await import("./pages/payment_statuses/list")).PaymentStatusList }));
const PaymentStatusCreate = lazy(async () => ({ default: (await import("./pages/payment_statuses/create")).PaymentStatusCreate }));
const PaymentStatusEdit = lazy(async () => ({ default: (await import("./pages/payment_statuses/edit")).PaymentStatusEdit }));
const PaymentStatusShow = lazy(async () => ({ default: (await import("./pages/payment_statuses/show")).PaymentStatusShow }));

const PaymentTypeList = lazy(async () => ({ default: (await import("./pages/payment_types/list")).PaymentTypeList }));
const PaymentTypeCreate = lazy(async () => ({ default: (await import("./pages/payment_types/create")).PaymentTypeCreate }));
const PaymentTypeEdit = lazy(async () => ({ default: (await import("./pages/payment_types/edit")).PaymentTypeEdit }));
const PaymentTypeShow = lazy(async () => ({ default: (await import("./pages/payment_types/show")).PaymentTypeShow }));

const PaymentList = lazy(async () => ({ default: (await import("./pages/payments/list")).PaymentList }));
const PaymentCreate = lazy(async () => ({ default: (await import("./pages/payments/create")).PaymentCreate }));
const PaymentEdit = lazy(async () => ({ default: (await import("./pages/payments/edit")).PaymentEdit }));
const PaymentShow = lazy(async () => ({ default: (await import("./pages/payments/show")).PaymentShow }));

const UnitList = lazy(async () => ({ default: (await import("./pages/units/list")).UnitList }));
const UnitCreate = lazy(async () => ({ default: (await import("./pages/units/create")).UnitCreate }));
const UnitEdit = lazy(async () => ({ default: (await import("./pages/units/edit")).UnitEdit }));
const UnitShow = lazy(async () => ({ default: (await import("./pages/units/show")).UnitShow }));

const RequisitionStatusList = lazy(async () => ({ default: (await import("./pages/requisition_statuses/list")).RequisitionStatusList }));
const RequisitionStatusCreate = lazy(async () => ({ default: (await import("./pages/requisition_statuses/create")).RequisitionStatusCreate }));
const RequisitionStatusEdit = lazy(async () => ({ default: (await import("./pages/requisition_statuses/edit")).RequisitionStatusEdit }));
const RequisitionStatusShow = lazy(async () => ({ default: (await import("./pages/requisition_statuses/show")).RequisitionStatusShow }));

const MovementStatusList = lazy(async () => ({ default: (await import("./pages/movements_statuses/list")).MovementStatusList }));
const MovementStatusCreate = lazy(async () => ({ default: (await import("./pages/movements_statuses/create")).MovementStatusCreate }));
const MovementStatusEdit = lazy(async () => ({ default: (await import("./pages/movements_statuses/edit")).MovementStatusEdit }));
const MovementStatusShow = lazy(async () => ({ default: (await import("./pages/movements_statuses/show")).MovementStatusShow }));

const MaterialTransactionTypeList = lazy(async () => ({ default: (await import("./pages/material_transaction_types/list")).MaterialTransactionTypeList }));
const MaterialTransactionTypeCreate = lazy(async () => ({ default: (await import("./pages/material_transaction_types/create")).MaterialTransactionTypeCreate }));
const MaterialTransactionTypeEdit = lazy(async () => ({ default: (await import("./pages/material_transaction_types/edit")).MaterialTransactionTypeEdit }));
const MaterialTransactionTypeShow = lazy(async () => ({ default: (await import("./pages/material_transaction_types/show")).MaterialTransactionTypeShow }));

const TransactionDirectionList = lazy(async () => ({ default: (await import("./pages/transaction_direction/list")).TransactionDirectionList }));
const TransactionDirectionCreate = lazy(async () => ({ default: (await import("./pages/transaction_direction/create")).TransactionDirectionCreate }));
const TransactionDirectionEdit = lazy(async () => ({ default: (await import("./pages/transaction_direction/edit")).TransactionDirectionEdit }));
const TransactionDirectionShow = lazy(async () => ({ default: (await import("./pages/transaction_direction/show")).TransactionDirectionShow }));

const ProductionStatusList = lazy(async () => ({ default: (await import("./pages/production_statuses/list")).ProductionStatusList }));
const ProductionStatusCreate = lazy(async () => ({ default: (await import("./pages/production_statuses/create")).ProductionStatusCreate }));
const ProductionStatusEdit = lazy(async () => ({ default: (await import("./pages/production_statuses/edit")).ProductionStatusEdit }));
const ProductionStatusShow = lazy(async () => ({ default: (await import("./pages/production_statuses/show")).ProductionStatusShow }));

const ResourceRequirementStatusList = lazy(async () => ({ default: (await import("./pages/resource_requirements_statuses/list")).ResourceRequirementStatusList }));
const ResourceRequirementStatusCreate = lazy(async () => ({ default: (await import("./pages/resource_requirements_statuses/create")).ResourceRequirementStatusCreate }));
const ResourceRequirementStatusEdit = lazy(async () => ({ default: (await import("./pages/resource_requirements_statuses/edit")).ResourceRequirementStatusEdit }));
const ResourceRequirementStatusShow = lazy(async () => ({ default: (await import("./pages/resource_requirements_statuses/show")).ResourceRequirementStatusShow }));

const EmployeeList = lazy(async () => ({ default: (await import("./pages/employees/list")).EmployeeList }));
const EmployeeCreate = lazy(async () => ({ default: (await import("./pages/employees/create")).EmployeeCreate }));
const EmployeeEdit = lazy(async () => ({ default: (await import("./pages/employees/edit")).EmployeeEdit }));
const EmployeeShow = lazy(async () => ({ default: (await import("./pages/employees/show")).EmployeeShow }));

const UserList = lazy(async () => ({ default: (await import("./pages/users/list")).UserList }));
const UserCreate = lazy(async () => ({ default: (await import("./pages/users/create")).UserCreate }));
const UserEdit = lazy(async () => ({ default: (await import("./pages/users/edit")).UserEdit }));
const UserShow = lazy(async () => ({ default: (await import("./pages/users/show")).UserShow }));

const WorkshopList = lazy(async () => ({ default: (await import("./pages/workshops/list")).WorkshopList }));
const WorkshopCreate = lazy(async () => ({ default: (await import("./pages/workshops/create")).WorkshopCreate }));
const WorkshopEdit = lazy(async () => ({ default: (await import("./pages/workshops/edit")).WorkshopEdit }));
const WorkshopShow = lazy(async () => ({ default: (await import("./pages/workshops/show")).WorkshopShow }));

const WorkCenterList = lazy(async () => ({ default: (await import("./pages/work_centers/list")).WorkCenterList }));
const WorkCenterCreate = lazy(async () => ({ default: (await import("./pages/work_centers/create")).WorkCenterCreate }));
const WorkCenterEdit = lazy(async () => ({ default: (await import("./pages/work_centers/edit")).WorkCenterEdit }));
const WorkCenterShow = lazy(async () => ({ default: (await import("./pages/work_centers/show")).WorkCenterShow }));

const OrderWorkshopList = lazy(async () => ({ default: (await import("./pages/order_workshops/list")).OrderWorkshopList }));
const OrderWorkshopCreate = lazy(async () => ({ default: (await import("./pages/order_workshops/create")).OrderWorkshopCreate }));
const OrderWorkshopEdit = lazy(async () => ({ default: (await import("./pages/order_workshops/edit")).OrderWorkshopEdit }));
const OrderWorkshopShow = lazy(async () => ({ default: (await import("./pages/order_workshops/show")).OrderWorkshopShow }));

const OrderResourceRequirementList = lazy(async () => ({ default: (await import("./pages/order_resource_requirements/list")).OrderResourceRequirementList }));
const OrderResourceRequirementCreate = lazy(async () => ({ default: (await import("./pages/order_resource_requirements/create")).OrderResourceRequirementCreate }));
const OrderResourceRequirementEdit = lazy(async () => ({ default: (await import("./pages/order_resource_requirements/edit")).OrderResourceRequirementEdit }));
const OrderResourceRequirementShow = lazy(async () => ({ default: (await import("./pages/order_resource_requirements/show")).OrderResourceRequirementShow }));

// clients_analytics and payments_analytics each export two named components from one module.
const ClientsAnalyticsList = lazy(async () => ({ default: (await import("./pages/clients_analytics")).ClientsAnalyticsList }));
const ClientsAnalyticsShow = lazy(async () => ({ default: (await import("./pages/clients_analytics")).ClientsAnalyticsShow }));
const PaymentsAnalyticsList = lazy(async () => ({ default: (await import("./pages/payments_analytics")).PaymentsAnalyticsList }));
const PaymentsAnalyticsShow = lazy(async () => ({ default: (await import("./pages/payments_analytics")).PaymentsAnalyticsShow }));

const AuditList = lazy(async () => ({ default: (await import("./pages/audit/list")).AuditList }));

const SheetMaterialList = lazy(async () => ({ default: (await import('./pages/sheet-materials/list')).SheetMaterialList }));
const SheetMaterialCreate = lazy(async () => ({ default: (await import('./pages/sheet-materials/create')).SheetMaterialCreate }));
const SheetMaterialEdit = lazy(async () => ({ default: (await import('./pages/sheet-materials/edit')).SheetMaterialEdit }));
const SheetMaterialShow = lazy(async () => ({ default: (await import('./pages/sheet-materials/show')).SheetMaterialShow }));

const API_URL = import.meta.env.VITE_HASURA_GRAPHQL_URL as string;

const App = () => (
  <AppThemeProvider>
    <ThemedApp />
  </AppThemeProvider>
);

const ThemedApp = () => {
  const { mode } = useAppTheme();

  // Configure notifications globally
  useEffect(() => {
    notification.config({
      placement: 'bottomRight',
      duration: 2, // 2 seconds instead of default 4.5
      maxCount: 3, // Limit visible notifications
    });
  }, []);

  return (
    <ErrorBoundary>
      <BrowserRouter>
        <RefineKbarProvider>
          <ConfigProvider
            locale={ruRU}
            theme={{
              algorithm: mode === "dark" ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
              token: {
                colorPrimary: "#1677ff",
                borderRadius: 6,
              },
            }}
            tooltip={{ mouseEnterDelay: 1 }}
            table={{ showSorterTooltip: { mouseEnterDelay: 1 } }}
          >
            <Refine
              dataProvider={dataProvider(API_URL)}
              notificationProvider={createNotificationProvider()}
              routerProvider={routerProvider}
              authProvider={authProvider}
              i18nProvider={i18nProvider}
              resources={[
                {
                  name: "orders_view",
                  list: "/orders",
                  edit: "/orders/edit/:id",
                  show: "/orders/show/:id",
                  meta: {
                    idColumnName: "order_id",
                    label: "Заказы",
                  },
                },
                {
                  name: "calendar",
                  list: "/calendar",
                  meta: {
                    label: "Календарь",
                  },
                },
                ...(featureFlags.useBackendProjects
                  ? [
                      {
                        name: "projects",
                        list: "/projects",
                        meta: {
                          idColumnName: "id",
                          label: "Проекты",
                        },
                      },
                    ]
                  : []),
                ...(featureFlags.useBackendCut
                  ? [
                      {
                        name: "cut-jobs",
                        list: "/cut",
                        meta: {
                          label: "Раскрой",
                        },
                      },
                    ]
                  : []),
                {
                  name: "materials",
                  list: "/materials",
                  create: "/materials/create",
                  edit: "/materials/edit/:id",
                  show: "/materials/show/:id",
                  meta: { idColumnName: "material_id", label: "Материалы" },
                },
                {
                  name: "sheet_material_types",
                  list: "/sheet-material-types",
                  create: "/sheet-material-types/create",
                  edit: "/sheet-material-types/edit/:id",
                  show: "/sheet-material-types/show/:id",
                  meta: { idColumnName: "sheet_material_type_id", label: "Листовые материалы" },
                },
                {
                  name: "milling_types",
                  list: "/milling-types",
                  create: "/milling-types/create",
                  edit: "/milling-types/edit/:id",
                  show: "/milling-types/show/:id",
                  meta: {
                    idColumnName: "milling_type_id",
                    label: "Типы фрезеровок",
                  },
                },
                {
                  name: "films",
                  list: "/films",
                  create: "/films/create",
                  edit: "/films/edit/:id",
                  show: "/films/show/:id",
                  meta: { idColumnName: "film_id", label: "Плёнки" },
                },
                {
                  name: "clients",
                  list: "/clients",
                  create: "/clients/create",
                  edit: "/clients/edit/:id",
                  show: "/clients/show/:id",
                  meta: { idColumnName: "client_id", label: "Клиенты" },
                },
                {
                  name: "clients_analytics_view",
                  list: "/clients-analytics",
                  show: "/clients-analytics/show/:id",
                  meta: { idColumnName: "client_id", label: "+Клиенты" },
                },
                {
                  name: "edge_types",
                  list: "/edge-types",
                  create: "/edge-types/create",
                  edit: "/edge-types/edit/:id",
                  show: "/edge-types/show/:id",
                  meta: { idColumnName: "edge_type_id", label: "Типы обката" },
                },
                {
                  name: "vendors",
                  list: "/vendors",
                  create: "/vendors/create",
                  edit: "/vendors/edit/:id",
                  show: "/vendors/show/:id",
                  meta: { idColumnName: "vendor_id", label: "Производители" },
                },
                {
                  name: "suppliers",
                  list: "/suppliers",
                  create: "/suppliers/create",
                  edit: "/suppliers/edit/:id",
                  show: "/suppliers/show/:id",
                  meta: { idColumnName: "supplier_id", label: "Поставщики" },
                },
                {
                  name: "film_types",
                  list: "/film-types",
                  create: "/film-types/create",
                  edit: "/film-types/edit/:id",
                  show: "/film-types/show/:id",
                  meta: { idColumnName: "film_type_id", label: "Типы плёнки" },
                },
                {
                  name: "material_types",
                  list: "/material-types",
                  create: "/material-types/create",
                  edit: "/material-types/edit/:id",
                  show: "/material-types/show/:id",
                  meta: {
                    idColumnName: "material_type_id",
                    label: "Типы материалов",
                  },
                },
                {
                  name: "order_statuses",
                  list: "/order-statuses",
                  create: "/order-statuses/create",
                  edit: "/order-statuses/edit/:id",
                  show: "/order-statuses/show/:id",
                  meta: { idColumnName: "order_status_id", label: "Статусы заказов" },
                },
                {
                  name: "payment_statuses",
                  list: "/payment-statuses",
                  create: "/payment-statuses/create",
                  edit: "/payment-statuses/edit/:id",
                  show: "/payment-statuses/show/:id",
                  meta: {
                    idColumnName: "payment_status_id",
                    label: "Статусы платежей",
                  },
                },
                {
                  name: "payment_types",
                  list: "/payment-types",
                  create: "/payment-types/create",
                  edit: "/payment-types/edit/:id",
                  show: "/payment-types/show/:id",
                  meta: { idColumnName: "type_paid_id", label: "Типы оплаты" },
                },
                {
                  name: "payments",
                  list: "/payments",
                  create: "/payments/create",
                  edit: "/payments/edit/:id",
                  show: "/payments/show/:id",
                  meta: { idColumnName: "payment_id", label: "Платежи" },
                },
                {
                  name: "payments_view",
                  list: "/payments-analytics",
                  show: "/payments-analytics/show/:id",
                  meta: { idColumnName: "payment_id", label: "+Платежи" },
                },
                {
                  name: "units",
                  list: "/units",
                  create: "/units/create",
                  edit: "/units/edit/:id",
                  show: "/units/show/:id",
                  meta: { idColumnName: "unit_id", label: "Единицы измерения" },
                },
                {
                  name: "requisition_statuses",
                  list: "/requisition-statuses",
                  create: "/requisition-statuses/create",
                  edit: "/requisition-statuses/edit/:id",
                  show: "/requisition-statuses/show/:id",
                  meta: {
                    idColumnName: "requisition_status_id",
                    label: "Статусы заявок на закупку",
                  },
                },
                {
                  name: "movements_statuses",
                  list: "/movements-statuses",
                  create: "/movements-statuses/create",
                  edit: "/movements-statuses/edit/:id",
                  show: "/movements-statuses/show/:id",
                  meta: {
                    idColumnName: "movement_status_id",
                    label: "Статусы перемещений",
                  },
                },
                {
                  name: "material_transaction_types",
                  list: "/material-transaction-types",
                  create: "/material-transaction-types/create",
                  edit: "/material-transaction-types/edit/:id",
                  show: "/material-transaction-types/show/:id",
                  meta: {
                    idColumnName: "transaction_type_id",
                    label: "Типы операций с материалами",
                  },
                },
                {
                  name: "transaction_direction",
                  list: "/transaction-direction",
                  create: "/transaction-direction/create",
                  edit: "/transaction-direction/edit/:id",
                  show: "/transaction-direction/show/:id",
                  meta: {
                    idColumnName: "direction_type_id",
                    label: "Направления движения",
                  },
                },
                {
                  name: "production_statuses",
                  list: "/production-statuses",
                  create: "/production-statuses/create",
                  edit: "/production-statuses/edit/:id",
                  show: "/production-statuses/show/:id",
                  meta: {
                    idColumnName: "production_status_id",
                    label: "Статусы производства",
                  },
                },
                {
                  name: "resource_requirements_statuses",
                  list: "/resource-requirements-statuses",
                  create: "/resource-requirements-statuses/create",
                  edit: "/resource-requirements-statuses/edit/:id",
                  show: "/resource-requirements-statuses/show/:id",
                  meta: {
                    idColumnName: "requirement_status_id",
                    label: "Статусы потребности в ресурсах",
                  },
                },
                {
                  name: "employees",
                  list: "/employees",
                  create: "/employees/create",
                  edit: "/employees/edit/:id",
                  show: "/employees/show/:id",
                  meta: { idColumnName: "employee_id", label: "Сотрудники" },
                },
                {
                  name: "users",
                  list: "/users",
                  create: "/users/create",
                  edit: "/users/edit/:id",
                  show: "/users/show/:id",
                  meta: { idColumnName: "user_id", label: "Пользователи" },
                },
                {
                  name: "workshops",
                  list: "/workshops",
                  create: "/workshops/create",
                  edit: "/workshops/edit/:id",
                  show: "/workshops/show/:id",
                  meta: { idColumnName: "workshop_id", label: "Цеха" },
                },
                {
                  name: "work_centers",
                  list: "/work-centers",
                  create: "/work-centers/create",
                  edit: "/work-centers/edit/:id",
                  show: "/work-centers/show/:id",
                  meta: { idColumnName: "workcenter_id", label: "Участки цехов" },
                },
                {
                  name: "order_workshops",
                  list: "/order-workshops",
                  create: "/order-workshops/create",
                  edit: "/order-workshops/edit/:id",
                  show: "/order-workshops/show/:id",
                  meta: { idColumnName: "order_workshop_id", label: "Order Workshops" },
                },
                {
                  name: "order_resource_requirements",
                  list: "/order-resource-requirements",
                  create: "/order-resource-requirements/create",
                  edit: "/order-resource-requirements/edit/:id",
                  show: "/order-resource-requirements/show/:id",
                  meta: { idColumnName: "requirement_id", label: "Order Resource Requirements" },
                },
                {
                  name: "order_doweling_links",
                  meta: { idColumnName: "order_doweling_link_id" },
                },
                {
                  name: "doweling_orders_view",
                  list: "/doweling-orders",
                  edit: "/doweling-orders/edit/:id",
                  show: "/doweling-orders/show/:id",
                  meta: { idColumnName: "doweling_order_id", label: "Присадка" },
                },
                {
                  name: "doweling_orders",
                  meta: { idColumnName: "doweling_order_id" },
                },
                {
                  name: "configuration",
                  list: "/configuration",
                  meta: { label: "Конфигурация" },
                },
                {
                  name: "audit",
                  list: "/audit",
                  meta: { label: "Аудит" },
                },
              ]}
              options={{
                syncWithLocation: true,
                // The workspace tab dirty registry owns unsaved-changes handling
                // (single beforeunload + close-confirm). Disable Refine's per-form prompt.
                warnWhenUnsavedChanges: false,
                disableTelemetry: true,
              }}
            >
              <Suspense
                fallback={
                  <div style={{ padding: 24, display: "flex", justifyContent: "center" }}>
                    <Spin />
                  </div>
                }
              >
                <Routes>
                <Route
                  element={
                    <Authenticated
                      key="authenticated-routes"
                      fallback={<CatchAllNavigate to="/login" />}
                    >
                      <WorkspaceLayout />
                    </Authenticated>
                  }
                >
                  <Route
                    index
                    element={<NavigateToResource resource="orders_view" />}
                  />
                  <Route path="/orders" >
                    <Route index element={<OrderList />} />
                    <Route path="edit/:id" element={<OrderEdit />} />
                    <Route path="show/:id" element={<OrderShow />} />
                  </Route>
                  <Route path="/calendar" >
                    <Route index element={<CalendarList />} />
                  </Route>
                  {featureFlags.useBackendProjects && (
                    <Route path="/projects">
                      <Route index element={<ProjectsPage />} />
                    </Route>
                  )}
                  {featureFlags.useBackendCut && (
                    <Route path="/cut">
                      <Route index element={<CutPage />} />
                    </Route>
                  )}
                  <Route path="/doweling-orders" >
                    <Route index element={<DowelOrderList />} />
                    <Route path="edit/:id" element={<DowelOrderEdit />} />
                    <Route path="show/:id" element={<DowelOrderShow />} />
                  </Route>
                  <Route path="/materials" >
                    <Route index element={<MaterialList />} />
                    <Route path="create" element={<MaterialCreate />} />
                    <Route path="edit/:id" element={<MaterialEdit />} />
                    <Route path="show/:id" element={<MaterialShow />} />
                  </Route>
                  <Route path="/sheet-material-types" >
                    <Route index element={<SheetMaterialList />} />
                    <Route path="create" element={<SheetMaterialCreate />} />
                    <Route path="edit/:id" element={<SheetMaterialEdit />} />
                    <Route path="show/:id" element={<SheetMaterialShow />} />
                  </Route>
                  <Route path="/milling-types" >
                    <Route index element={<MillingTypeList />} />
                    <Route path="create" element={<MillingTypeCreate />} />
                    <Route path="edit/:id" element={<MillingTypeEdit />} />
                    <Route path="show/:id" element={<MillingTypeShow />} />
                  </Route>
                  <Route path="/films" >
                    <Route index element={<FilmList />} />
                    <Route path="create" element={<FilmCreate />} />
                    <Route path="edit/:id" element={<FilmEdit />} />
                    <Route path="show/:id" element={<FilmShow />} />
                  </Route>
                  <Route path="/clients" >
                    <Route index element={<ClientList />} />
                    <Route path="create" element={<ClientCreate />} />
                    <Route path="edit/:id" element={<ClientEdit />} />
                    <Route path="show/:id" element={<ClientShow />} />
                  </Route>
                  <Route path="/clients-analytics" >
                    <Route index element={<ClientsAnalyticsList />} />
                    <Route path="show/:id" element={<ClientsAnalyticsShow />} />
                  </Route>
                  <Route path="/edge-types" >
                    <Route index element={<EdgeTypeList />} />
                    <Route path="create" element={<EdgeTypeCreate />} />
                    <Route path="edit/:id" element={<EdgeTypeEdit />} />
                    <Route path="show/:id" element={<EdgeTypeShow />} />
                  </Route>
                  <Route path="/vendors" >
                    <Route index element={<VendorList />} />
                    <Route path="create" element={<VendorCreate />} />
                    <Route path="edit/:id" element={<VendorEdit />} />
                    <Route path="show/:id" element={<VendorShow />} />
                  </Route>
                  <Route path="/suppliers" >
                    <Route index element={<SupplierList />} />
                    <Route path="create" element={<SupplierCreate />} />
                    <Route path="edit/:id" element={<SupplierEdit />} />
                    <Route path="show/:id" element={<SupplierShow />} />
                  </Route>
                  <Route path="/film-types" >
                    <Route index element={<FilmTypeList />} />
                    <Route path="create" element={<FilmTypeCreate />} />
                    <Route path="edit/:id" element={<FilmTypeEdit />} />
                    <Route path="show/:id" element={<FilmTypeShow />} />
                  </Route>
                  <Route path="/material-types" >
                    <Route index element={<MaterialTypeList />} />
                    <Route path="create" element={<MaterialTypeCreate />} />
                    <Route path="edit/:id" element={<MaterialTypeEdit />} />
                    <Route path="show/:id" element={<MaterialTypeShow />} />
                  </Route>
                  <Route path="/order-statuses" >
                    <Route index element={<OrderStatusList />} />
                    <Route path="create" element={<OrderStatusCreate />} />
                    <Route path="edit/:id" element={<OrderStatusEdit />} />
                    <Route path="show/:id" element={<OrderStatusShow />} />
                  </Route>
                  <Route path="/payment-statuses" >
                    <Route index element={<PaymentStatusList />} />
                    <Route path="create" element={<PaymentStatusCreate />} />
                    <Route path="edit/:id" element={<PaymentStatusEdit />} />
                    <Route path="show/:id" element={<PaymentStatusShow />} />
                  </Route>
                  <Route path="/payment-types" >
                    <Route index element={<PaymentTypeList />} />
                    <Route path="create" element={<PaymentTypeCreate />} />
                    <Route path="edit/:id" element={<PaymentTypeEdit />} />
                    <Route path="show/:id" element={<PaymentTypeShow />} />
                  </Route>
                  <Route path="/units" >
                    <Route index element={<UnitList />} />
                    <Route path="create" element={<UnitCreate />} />
                    <Route path="edit/:id" element={<UnitEdit />} />
                    <Route path="show/:id" element={<UnitShow />} />
                  </Route>
                  <Route path="/payments" >
                    <Route index element={<PaymentList />} />
                    <Route path="create" element={<PaymentCreate />} />
                    <Route path="edit/:id" element={<PaymentEdit />} />
                    <Route path="show/:id" element={<PaymentShow />} />
                  </Route>
                  <Route path="/payments-analytics" >
                    <Route index element={<PaymentsAnalyticsList />} />
                    <Route path="show/:id" element={<PaymentsAnalyticsShow />} />
                  </Route>
                  <Route path="/requisition-statuses" >
                    <Route index element={<RequisitionStatusList />} />
                    <Route path="create" element={<RequisitionStatusCreate />} />
                    <Route path="edit/:id" element={<RequisitionStatusEdit />} />
                    <Route path="show/:id" element={<RequisitionStatusShow />} />
                  </Route>
                  <Route path="/movements-statuses" >
                    <Route index element={<MovementStatusList />} />
                    <Route path="create" element={<MovementStatusCreate />} />
                    <Route path="edit/:id" element={<MovementStatusEdit />} />
                    <Route path="show/:id" element={<MovementStatusShow />} />
                  </Route>
                  <Route path="/material-transaction-types" >
                    <Route index element={<MaterialTransactionTypeList />} />
                    <Route path="create" element={<MaterialTransactionTypeCreate />} />
                    <Route path="edit/:id" element={<MaterialTransactionTypeEdit />} />
                    <Route path="show/:id" element={<MaterialTransactionTypeShow />} />
                  </Route>
                  <Route path="/transaction-direction" >
                    <Route index element={<TransactionDirectionList />} />
                    <Route path="create" element={<TransactionDirectionCreate />} />
                    <Route path="edit/:id" element={<TransactionDirectionEdit />} />
                    <Route path="show/:id" element={<TransactionDirectionShow />} />
                  </Route>
                  <Route path="/production-statuses" >
                    <Route index element={<ProductionStatusList />} />
                    <Route path="create" element={<ProductionStatusCreate />} />
                    <Route path="edit/:id" element={<ProductionStatusEdit />} />
                    <Route path="show/:id" element={<ProductionStatusShow />} />
                  </Route>
                  <Route path="/resource-requirements-statuses" >
                    <Route index element={<ResourceRequirementStatusList />} />
                    <Route path="create" element={<ResourceRequirementStatusCreate />} />
                    <Route path="edit/:id" element={<ResourceRequirementStatusEdit />} />
                    <Route path="show/:id" element={<ResourceRequirementStatusShow />} />
                  </Route>
                  <Route path="/employees" >
                    <Route index element={<EmployeeList />} />
                    <Route path="create" element={<EmployeeCreate />} />
                    <Route path="edit/:id" element={<EmployeeEdit />} />
                    <Route path="show/:id" element={<EmployeeShow />} />
                  </Route>
                  <Route path="/users" >
                    <Route index element={<UserList />} />
                    <Route path="create" element={<UserCreate />} />
                    <Route path="edit/:id" element={<UserEdit />} />
                    <Route path="show/:id" element={<UserShow />} />
                  </Route>
                  <Route path="/configuration" element={<ConfigurationPage />} />
                  <Route path="/profile" element={<ProfilePage />} />
                  <Route path="/audit">
                    <Route index element={<AuditList />} />
                  </Route>
                  <Route path="/workshops" >
                    <Route index element={<WorkshopList />} />
                    <Route path="create" element={<WorkshopCreate />} />
                    <Route path="edit/:id" element={<WorkshopEdit />} />
                    <Route path="show/:id" element={<WorkshopShow />} />
                  </Route>
                  <Route path="/work-centers" >
                    <Route index element={<WorkCenterList />} />
                    <Route path="create" element={<WorkCenterCreate />} />
                    <Route path="edit/:id" element={<WorkCenterEdit />} />
                    <Route path="show/:id" element={<WorkCenterShow />} />
                  </Route>
                  <Route path="/order-workshops" >
                    <Route index element={<OrderWorkshopList />} />
                    <Route path="create" element={<OrderWorkshopCreate />} />
                    <Route path="edit/:id" element={<OrderWorkshopEdit />} />
                    <Route path="show/:id" element={<OrderWorkshopShow />} />
                  </Route>
                  <Route path="/order-resource-requirements" >
                    <Route index element={<OrderResourceRequirementList />} />
                    <Route path="create" element={<OrderResourceRequirementCreate />} />
                    <Route path="edit/:id" element={<OrderResourceRequirementEdit />} />
                    <Route path="show/:id" element={<OrderResourceRequirementShow />} />
                  </Route>
                </Route>
                <Route
                  element={<Outlet />}
                >
                  <Route path="/login" element={<LoginPage />} />
                </Route>
                </Routes>
              </Suspense>
              <RefineKbar />
            </Refine>
          </ConfigProvider>
        </RefineKbarProvider>
      </BrowserRouter>
    </ErrorBoundary>
  );
}

export default App;
