import React from "react";
import { Layout, Space, Avatar, Typography, Tag } from "antd";
import { useGetIdentity } from "@refinedev/core";

export const AppHeader: React.FC = () => {
  const { data: identity } = useGetIdentity<{ id: number; name?: string; full_name?: string; username?: string }>();
  const name = identity?.full_name || identity?.name || identity?.username || "User";
  const devUserId = (import.meta as any).env.VITE_DEV_AUDIT_USER_ID ?? 1;

  return (
    <Layout.Header
      style={{
        background: "#fff",
        padding: "0 16px",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        borderBottom: "1px solid #f0f0f0",
      }}
    >
      <Space size="middle" align="center">
        <Typography.Text strong>ERP Admin</Typography.Text>
      </Space>
      <Space size="middle" align="center">
        <Tag color="blue">DEV</Tag>
        <span style={{ color: "#999", fontSize: 12 }}>user_id: {String(devUserId)}</span>
        <Avatar style={{ backgroundColor: "#1677ff" }}>{String(name).substring(0, 1).toUpperCase()}</Avatar>
        <Typography.Text strong>{name}</Typography.Text>
      </Space>
    </Layout.Header>
  );
};

export default AppHeader;
