import { Refine, Authenticated } from "@refinedev/core";
import { RefineKbar, RefineKbarProvider } from "@refinedev/kbar";
import { CustomLayout } from "./components/CustomLayout";
import routerProvider, { CatchAllNavigate, NavigateToResource } from "@refinedev/react-router-v6";
import { BrowserRouter, Route, Routes, Outlet } from "react-router-dom";
import { ConfigProvider } from "antd";
import ruRU from 'antd/locale/ru_RU';
import "@refinedev/antd/dist/reset.css";
import "./styles/app.css";
import { createNotificationProvider } from "./providers/notificationProvider";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { OrderList } from "./pages/orders/list";
import { OrderShow } from "./pages/orders/show";
import { OrderEdit } from "./pages/orders/edit";
import { CalendarList } from "./pages/calendar";
import { MaterialList } from "./pages/materials/list";
import { MaterialCreate } from "./pages/materials/create";
import { MaterialEdit } from "./pages/materials/edit";
import { MaterialShow } from "./pages/materials/show";
import { MillingTypeList } from "./pages/milling_types/list";
import { MillingTypeCreate } from "./pages/milling_types/create";
import { MillingTypeEdit } from "./pages/milling_types/edit";
import { MillingTypeShow } from "./pages/milling_types/show";
import { FilmList } from "./pages/films/list";
import { FilmCreate } from "./pages/films/create";
import { FilmEdit } from "./pages/films/edit";
import { FilmShow } from "./pages/films/show";
import { ClientList } from "./pages/clients/list";
import { ClientCreate } from "./pages/clients/create";
import { ClientEdit } from "./pages/clients/edit";
import { ClientShow } from "./pages/clients/show";
import { EdgeTypeList } from "./pages/edge_types/list";
import { EdgeTypeCreate } from "./pages/edge_types/create";
import { EdgeTypeEdit } from "./pages/edge_types/edit";
import { EdgeTypeShow } from "./pages/edge_types/show";
import { VendorList } from "./pages/vendors/list";
import { VendorCreate } from "./pages/vendors/create";
import { VendorEdit } from "./pages/vendors/edit";
import { VendorShow } from "./pages/vendors/show";
import { SupplierList } from "./pages/suppliers/list";
import { SupplierCreate } from "./pages/suppliers/create";
import { SupplierEdit } from "./pages/suppliers/edit";
import { SupplierShow } from "./pages/suppliers/show";
import { FilmTypeList } from "./pages/film_types/list";
import { FilmTypeCreate } from "./pages/film_types/create";
import { FilmTypeEdit } from "./pages/film_types/edit";
import { FilmTypeShow } from "./pages/film_types/show";
import { MaterialTypeList } from "./pages/material_types/list";
import { MaterialTypeCreate } from "./pages/material_types/create";
import { MaterialTypeEdit } from "./pages/material_types/edit";
import { MaterialTypeShow } from "./pages/material_types/show";
import { OrderStatusList } from "./pages/order_statuses/list";
import { OrderStatusCreate } from "./pages/order_statuses/create";
import { OrderStatusEdit } from "./pages/order_statuses/edit";
import { OrderStatusShow } from "./pages/order_statuses/show";
import { PaymentStatusList } from "./pages/payment_statuses/list";
import { PaymentStatusCreate } from "./pages/payment_statuses/create";
import { PaymentStatusEdit } from "./pages/payment_statuses/edit";
import { PaymentStatusShow } from "./pages/payment_statuses/show";
import { PaymentTypeList } from "./pages/payment_types/list";
import { PaymentTypeCreate } from "./pages/payment_types/create";
import { PaymentTypeEdit } from "./pages/payment_types/edit";
import { PaymentTypeShow } from "./pages/payment_types/show";
import { PaymentList } from "./pages/payments/list";
import { PaymentCreate } from "./pages/payments/create";
import { PaymentEdit } from "./pages/payments/edit";
import { PaymentShow } from "./pages/payments/show";
import { UnitList } from "./pages/units/list";
import { UnitCreate } from "./pages/units/create";
import { UnitEdit } from "./pages/units/edit";
import { UnitShow } from "./pages/units/show";
import { RequisitionStatusList } from "./pages/requisition_statuses/list";
import { RequisitionStatusCreate } from "./pages/requisition_statuses/create";
import { RequisitionStatusEdit } from "./pages/requisition_statuses/edit";
import { RequisitionStatusShow } from "./pages/requisition_statuses/show";
import { MovementStatusList } from "./pages/movements_statuses/list";
import { MovementStatusCreate } from "./pages/movements_statuses/create";
import { MovementStatusEdit } from "./pages/movements_statuses/edit";
import { MovementStatusShow } from "./pages/movements_statuses/show";
import { MaterialTransactionTypeList } from "./pages/material_transaction_types/list";
import { MaterialTransactionTypeCreate } from "./pages/material_transaction_types/create";
import { MaterialTransactionTypeEdit } from "./pages/material_transaction_types/edit";
import { MaterialTransactionTypeShow } from "./pages/material_transaction_types/show";
import { TransactionDirectionList } from "./pages/transaction_direction/list";
import { TransactionDirectionCreate } from "./pages/transaction_direction/create";
import { TransactionDirectionEdit } from "./pages/transaction_direction/edit";
import { TransactionDirectionShow } from "./pages/transaction_direction/show";
import { ProductionStatusList } from "./pages/production_statuses/list";
import { ProductionStatusCreate } from "./pages/production_statuses/create";
import { ProductionStatusEdit } from "./pages/production_statuses/edit";
import { ProductionStatusShow } from "./pages/production_statuses/show";
import { ResourceRequirementStatusList } from "./pages/resource_requirements_statuses/list";
import { ResourceRequirementStatusCreate } from "./pages/resource_requirements_statuses/create";
import { ResourceRequirementStatusEdit } from "./pages/resource_requirements_statuses/edit";
import { ResourceRequirementStatusShow } from "./pages/resource_requirements_statuses/show";
import { EmployeeList } from "./pages/employees/list";
import { EmployeeCreate } from "./pages/employees/create";
import { EmployeeEdit } from "./pages/employees/edit";
import { EmployeeShow } from "./pages/employees/show";
import { UserList } from "./pages/users/list";
import { UserCreate } from "./pages/users/create";
import { UserEdit } from "./pages/users/edit";
import { UserShow } from "./pages/users/show";
import { WorkshopList } from "./pages/workshops/list";
import { WorkshopCreate } from "./pages/workshops/create";
import { WorkshopEdit } from "./pages/workshops/edit";
import { WorkshopShow } from "./pages/workshops/show";
import { WorkCenterList } from "./pages/work_centers/list";
import { WorkCenterCreate } from "./pages/work_centers/create";
import { WorkCenterEdit } from "./pages/work_centers/edit";
import { WorkCenterShow } from "./pages/work_centers/show";
import { OrderWorkshopList } from "./pages/order_workshops/list";
import { OrderWorkshopCreate } from "./pages/order_workshops/create";
import { OrderWorkshopEdit } from "./pages/order_workshops/edit";
import { OrderWorkshopShow } from "./pages/order_workshops/show";
import { OrderResourceRequirementList } from "./pages/order_resource_requirements/list";
import { OrderResourceRequirementCreate } from "./pages/order_resource_requirements/create";
import { OrderResourceRequirementEdit } from "./pages/order_resource_requirements/edit";
import { OrderResourceRequirementShow } from "./pages/order_resource_requirements/show";
import { LoginPage } from "./pages/login";
import { dataProvider } from "./utils/dataProvider";
import { authProvider } from "./authProvider";
import { i18nProvider } from "./utils/i18nProvider";

const API_URL = import.meta.env.VITE_HASURA_GRAPHQL_URL as string;

const App = () => {

  return (
    <ErrorBoundary>
      <BrowserRouter>
        <RefineKbarProvider>
          <ConfigProvider locale={ruRU}>
            <Refine
              dataProvider={dataProvider(API_URL)}
              notificationProvider={createNotificationProvider()}
              routerProvider={routerProvider}
              authProvider={authProvider}
              i18nProvider={i18nProvider}
              Layout={CustomLayout}
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
                {
                  name: "materials",
                  list: "/materials",
                  create: "/materials/create",
                  edit: "/materials/edit/:id",
                  show: "/materials/show/:id",
                  meta: { idColumnName: "material_id" },
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
                  meta: { idColumnName: "film_id" },
                },
                {
                  name: "clients",
                  list: "/clients",
                  create: "/clients/create",
                  edit: "/clients/edit/:id",
                  show: "/clients/show/:id",
                  meta: { idColumnName: "client_id" },
                },
                {
                  name: "edge_types",
                  list: "/edge-types",
                  create: "/edge-types/create",
                  edit: "/edge-types/edit/:id",
                  show: "/edge-types/show/:id",
                  meta: { idColumnName: "edge_type_id" },
                },
                {
                  name: "vendors",
                  list: "/vendors",
                  create: "/vendors/create",
                  edit: "/vendors/edit/:id",
                  show: "/vendors/show/:id",
                  meta: { idColumnName: "vendor_id" },
                },
                {
                  name: "suppliers",
                  list: "/suppliers",
                  create: "/suppliers/create",
                  edit: "/suppliers/edit/:id",
                  show: "/suppliers/show/:id",
                  meta: { idColumnName: "supplier_id" },
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
                  meta: { idColumnName: "material_type_id" },
                },
                {
                  name: "order_statuses",
                  list: "/order-statuses",
                  create: "/order-statuses/create",
                  edit: "/order-statuses/edit/:id",
                  show: "/order-statuses/show/:id",
                  meta: { idColumnName: "order_status_id" },
                },
                {
                  name: "payment_statuses",
                  list: "/payment-statuses",
                  create: "/payment-statuses/create",
                  edit: "/payment-statuses/edit/:id",
                  show: "/payment-statuses/show/:id",
                  meta: { idColumnName: "payment_status_id" },
                },
                {
                  name: "payment_types",
                  list: "/payment-types",
                  create: "/payment-types/create",
                  edit: "/payment-types/edit/:id",
                  show: "/payment-types/show/:id",
                  meta: { idColumnName: "type_paid_id" },
                },
                {
                  name: "payments",
                  list: "/payments",
                  create: "/payments/create",
                  edit: "/payments/edit/:id",
                  show: "/payments/show/:id",
                  meta: { idColumnName: "payment_id" },
                },
                {
                  name: "units",
                  list: "/units",
                  create: "/units/create",
                  edit: "/units/edit/:id",
                  show: "/units/show/:id",
                  meta: { idColumnName: "unit_id", label: "Units" },
                },
                {
                  name: "requisition_statuses",
                  list: "/requisition-statuses",
                  create: "/requisition-statuses/create",
                  edit: "/requisition-statuses/edit/:id",
                  show: "/requisition-statuses/show/:id",
                  meta: { idColumnName: "requisition_status_id", label: "Requisition Statuses" },
                },
                {
                  name: "movements_statuses",
                  list: "/movements-statuses",
                  create: "/movements-statuses/create",
                  edit: "/movements-statuses/edit/:id",
                  show: "/movements-statuses/show/:id",
                  meta: { idColumnName: "movement_status_id", label: "Movement Statuses" },
                },
                {
                  name: "material_transaction_types",
                  list: "/material-transaction-types",
                  create: "/material-transaction-types/create",
                  edit: "/material-transaction-types/edit/:id",
                  show: "/material-transaction-types/show/:id",
                  meta: { idColumnName: "transaction_type_id", label: "Material Transaction Types" },
                },
                {
                  name: "transaction_direction",
                  list: "/transaction-direction",
                  create: "/transaction-direction/create",
                  edit: "/transaction-direction/edit/:id",
                  show: "/transaction-direction/show/:id",
                  meta: { idColumnName: "direction_type_id", label: "Transaction Direction" },
                },
                {
                  name: "production_statuses",
                  list: "/production-statuses",
                  create: "/production-statuses/create",
                  edit: "/production-statuses/edit/:id",
                  show: "/production-statuses/show/:id",
                  meta: { idColumnName: "production_status_id", label: "Production Statuses" },
                },
                {
                  name: "resource_requirements_statuses",
                  list: "/resource-requirements-statuses",
                  create: "/resource-requirements-statuses/create",
                  edit: "/resource-requirements-statuses/edit/:id",
                  show: "/resource-requirements-statuses/show/:id",
                  meta: { idColumnName: "requirement_status_id", label: "Resource Requirements Statuses" },
                },
                {
                  name: "employees",
                  list: "/employees",
                  create: "/employees/create",
                  edit: "/employees/edit/:id",
                  show: "/employees/show/:id",
                  meta: { idColumnName: "employee_id", label: "Employees" },
                },
                {
                  name: "users",
                  list: "/users",
                  create: "/users/create",
                  edit: "/users/edit/:id",
                  show: "/users/show/:id",
                  meta: { idColumnName: "user_id", label: "Users" },
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
              ]}
              options={{
                syncWithLocation: true,
                warnWhenUnsavedChanges: true,
                disableTelemetry: true,
              }}
            >
              <Routes>
                <Route
                  element={
                    <Authenticated
                      key="authenticated-routes"
                      fallback={<CatchAllNavigate to="/login" />}
                    >
                      <CustomLayout>
                        <Outlet />
                      </CustomLayout>
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
                  <Route path="/materials" >
                    <Route index element={<MaterialList />} />
                    <Route path="create" element={<MaterialCreate />} />
                    <Route path="edit/:id" element={<MaterialEdit />} />
                    <Route path="show/:id" element={<MaterialShow />} />
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
                  </Route>                <Route path="/requisition-statuses" >
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
              <RefineKbar />
            </Refine>
          </ConfigProvider>
        </RefineKbarProvider>
      </BrowserRouter>
    </ErrorBoundary>
  );
}

export default App;


