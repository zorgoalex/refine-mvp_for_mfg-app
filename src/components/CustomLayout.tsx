import React from "react";
import { Layout as RefineLayout } from "@refinedev/antd";
import { AppHeader } from "./AppHeader";
import { AppFooter } from "./AppFooter";
import { CustomSider } from "./CustomSider";

export const CustomLayout: React.FC<React.PropsWithChildren> = ({ children }) => {
  return (
    <RefineLayout Header={AppHeader} Sider={CustomSider}>
      <div style={{ minHeight: "100%", display: "flex", flexDirection: "column" }}>
        <div style={{ flex: 1 }}>{children}</div>
        <AppFooter />
      </div>
    </RefineLayout>
  );
};

export default CustomLayout;
