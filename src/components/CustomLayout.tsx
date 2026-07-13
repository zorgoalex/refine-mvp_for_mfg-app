import React, { useEffect, useState } from "react";
import { Layout as RefineLayout } from "@refinedev/antd";
import { AppHeader } from "./AppHeader";
import { AppFooter } from "./AppFooter";
import { CustomSider } from "./CustomSider";
import { MobileSiderDrawer } from "./MobileSiderDrawer";
import { useIsMobile } from "../hooks/useDeviceTier";
import { GlobalTableTopScrollbars } from "./GlobalTableTopScrollbars";

export const CustomLayout: React.FC<React.PropsWithChildren> = ({ children }) => {
  const [isSiderOpen, setIsSiderOpen] = useState(false);
  const isMobile = useIsMobile();

  const openSider = () => setIsSiderOpen(true);
  const closeSider = () => setIsSiderOpen(false);

  useEffect(() => {
    if (!isMobile) return;
    const style = document.createElement("style");
    style.setAttribute("data-calendar-mobile-fix", "true");
    style.textContent = `
      /* Hide the duplicate fixed sider-trigger button that Refine/AntD
         leaves in the DOM on mobile (position: fixed; top: 64px;
         z-index: 999; bars icon inside). The burger in AppHeader is
         the single source of truth for opening the mobile drawer. */
      button.ant-btn.ant-btn-default.ant-btn-lg.ant-btn-icon-only:has(> span[aria-label="bars"]) {
        display: none !important;
      }
    `;
    document.head.appendChild(style);
    return () => {
      style.remove();
    };
  }, [isMobile]);

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
        <GlobalTableTopScrollbars />
        <div style={{ flex: 1 }}>{children}</div>
        <AppFooter />
      </div>
      {isMobile && <MobileSiderDrawer open={isSiderOpen} onClose={closeSider} />}
    </RefineLayout>
  );
};

export default CustomLayout;
