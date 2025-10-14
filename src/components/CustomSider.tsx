import React from "react";
import { Layout as AntLayout, Menu } from "antd";
import type { MenuProps } from "antd";
import { useMenu } from "@refinedev/core";
import { Link } from "react-router-dom";

const mapToMenuItems = (items: any[]): MenuProps["items"] =>
  items.map((item) => ({
    key: item.key,
    icon: item.icon as React.ReactNode,
    label: item.route ? <Link to={item.route}>{item.label}</Link> : item.label,
    children: item.children && item.children.length > 0 ? mapToMenuItems(item.children) : undefined,
  }));

export const CustomSider: React.FC = () => {
  const { menuItems, selectedKey, defaultOpenKeys } = useMenu();

  return (
    <AntLayout.Sider collapsible>
      <Menu
        mode="inline"
        selectedKeys={selectedKey ? [selectedKey] : []}
        defaultOpenKeys={defaultOpenKeys}
        items={mapToMenuItems(menuItems)}
      />
    </AntLayout.Sider>
  );
};

export default CustomSider;

