import React, { useState } from "react";
import { Layout as RefineLayout } from "@refinedev/antd";
import { AppHeader } from "./AppHeader";
import { AppFooter } from "./AppFooter";
import { CustomSider } from "./CustomSider";
import { MobileSiderDrawer } from "./MobileSiderDrawer";
import { useMediaQuery } from "../hooks/useMediaQuery";

export const CustomLayout: React.FC<React.PropsWithChildren> = ({ children }) => {
  const [isSiderOpen, setIsSiderOpen] = useState(false);
  const isMobile = useMediaQuery("(max-width: 768px)");

  const openSider = () => setIsSiderOpen(true);
  const closeSider = () => setIsSiderOpen(false);

  return (
    <RefineLayout
      Header={() => <AppHeader onOpenSider={isMobile ? openSider : undefined} />}
      // AD-5: on mobile, pass `Sider={undefined}` (not `() => null`)
      // — passing a component (even one returning null) makes Antd
      // Layout reserve its width as padding-left on the content
      // area, leaving a large empty gutter on the left.
      Sider={isMobile ? undefined : CustomSider}
    >
      <div style={{ minHeight: "100%", display: "flex", flexDirection: "column" }}>
        <div style={{ flex: 1 }}>{children}</div>
        <AppFooter />
      </div>
      {isMobile && <MobileSiderDrawer open={isSiderOpen} onClose={closeSider} />}
    </RefineLayout>
  );
};

export default CustomLayout;
