import React from "react";
import { Layout, Space, Typography } from "antd";
import { useOrderFormStore } from "../stores/orderFormStore";

export const AppFooter: React.FC = () => {
  // Avoid returning new object snapshots from store selector to prevent re-render loops.
  const positionsCount = useOrderFormStore((s) => s.details.length);
  const partsCount = useOrderFormStore((s) => s.details.reduce((sum, d) => sum + (d.quantity || 0), 0));
  const totalArea = useOrderFormStore((s) => s.details.reduce((sum, d) => sum + (d.area || 0), 0));
  const totalPaid = useOrderFormStore((s) => s.payments.reduce((sum, p) => sum + (p.amount || 0), 0));
  const apiUrl = (import.meta as any).env.VITE_HASURA_GRAPHQL_URL as string;

  return (
    <Layout.Footer
      style={{
        background: "#fff",
        borderTop: "1px solid #f0f0f0",
        padding: "8px 16px",
        position: "sticky",
        bottom: 0,
        zIndex: 5,
      }}
    >
      <Space size="large" wrap>
        <Typography.Text type="secondary">API: {apiUrl}</Typography.Text>
        <>
          <Typography.Text type="secondary">Позиций: {positionsCount}</Typography.Text>
          <Typography.Text type="secondary">Деталей: {partsCount}</Typography.Text>
          <Typography.Text type="secondary">Площадь: {totalArea.toFixed(2)}</Typography.Text>
          <Typography.Text type="secondary">Оплачено: {totalPaid.toFixed(2)}</Typography.Text>
        </>
      </Space>
    </Layout.Footer>
  );
};

export default AppFooter;
