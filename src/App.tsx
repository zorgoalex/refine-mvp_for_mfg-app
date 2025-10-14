import { Refine, AuthProvider, Authenticated } from "@refinedev/core";
import { RefineKbar, RefineKbarProvider } from "@refinedev/kbar";
import { notificationProvider, Layout } from "@refinedev/antd";
import { CustomSider } from "./components/CustomSider";
import routerProvider, { CatchAllNavigate, NavigateToResource } from "@refinedev/react-router-v6";
import { BrowserRouter, Route, Routes, Outlet } from "react-router-dom";
import { ConfigProvider } from "antd";
import "@refinedev/antd/dist/reset.css";
import { OrderList } from "./pages/orders/list";
// OrderCreate/Edit routes are disabled for read-only orders_view
import { OrderShow } from "./pages/orders/show";
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
import { LoginPage } from "./pages/login";
import { dataProvider } from "./utils/dataProvider";

const API_URL = import.meta.env.VITE_API_URL as string;
const API_TOKEN = import.meta.env.VITE_API_TOKEN as string;

const App = () => {
  const authProvider: AuthProvider = {
    login: async () => {
      // Dev mode: token comes from .env; nothing to do
      return { success: true, redirectTo: "/" };
    },
    logout: async () => {
      // Dev mode: no token state to clear; allow navigating to login
      return { success: true, redirectTo: "/login" };
    },
    check: async () => {
      if (API_TOKEN) {
        return { authenticated: true };
      }
      return { authenticated: false, redirectTo: "/login" };
    },
    getPermissions: async () => null,
  };

  return (
    <BrowserRouter>
      <RefineKbarProvider>
        <ConfigProvider>
          <Refine
            dataProvider={dataProvider(API_URL)}
            notificationProvider={notificationProvider}
            routerProvider={routerProvider}
            authProvider={authProvider}
            resources={[
              {
                name: "orders_view",
                list: "/orders",
                show: "/orders/show/:id",
                meta: { idColumnName: "order_id" },
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
                meta: { idColumnName: "milling_type_id" },
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
            ]}
            options={{
              syncWithLocation: true,
              warnWhenUnsavedChanges: true,
            }}
          >
            <Routes>
              <Route
                element={
                  <Authenticated
                    key="authenticated-routes"
                    fallback={<CatchAllNavigate to="/login" />}
                  >
                    <Layout Sider={CustomSider}>
                      <Outlet />
                    </Layout>
                  </Authenticated>
                }
              >
                <Route
                  index
                  element={<NavigateToResource resource="orders_view" />}
                />
                <Route path="/orders" >
                  <Route index element={<OrderList />} />
                  <Route path="show/:id" element={<OrderShow />} />
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
  );
}

export default App;
