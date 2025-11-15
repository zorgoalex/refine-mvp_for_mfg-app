import { IResourceComponentsProps, useMany, useNavigation } from "@refinedev/core";
import { List, useTable, ShowButton, EditButton } from "@refinedev/antd";
import { Space, Table } from "antd";
import { useMemo } from "react";
import { useHighlightRow } from "../../hooks/useHighlightRow";

export const PaymentList: React.FC<IResourceComponentsProps> = () => {
  const { tableProps } = useTable({
    syncWithLocation: true,
    sorters: { initial: [{ field: "payment_id", order: "desc" }] },
  });
  const { highlightProps } = useHighlightRow("payment_id", tableProps.dataSource);
  const { show } = useNavigation();

  const orderIds = useMemo(
    () => Array.from(new Set(((tableProps?.dataSource as any[]) || []).map((i) => i?.order_id).filter((v) => v != null))),
    [tableProps?.dataSource]
  );
  const typeIds = useMemo(
    () => Array.from(new Set(((tableProps?.dataSource as any[]) || []).map((i) => i?.type_paid_id).filter((v) => v != null))),
    [tableProps?.dataSource]
  );

  const { data: ordersData } = useMany({ resource: "orders", ids: orderIds, queryOptions: { enabled: orderIds.length > 0 } });
  const { data: typesData } = useMany({ resource: "payment_types", ids: typeIds, queryOptions: { enabled: typeIds.length > 0 } });

  const orderMap = useMemo(() => {
    const map: Record<string | number, string> = {};
    (ordersData?.data || []).forEach((o: any) => (map[o.order_id] = o.order_number ?? o.order_id));
    return map;
  }, [ordersData]);

  const typeMap = useMemo(() => {
    const map: Record<string | number, string> = {};
    (typesData?.data || []).forEach((t: any) => (map[t.type_paid_id] = t.type_paid_name));
    return map;
  }, [typesData]);

  return (
    <List>
      <Table
        {...tableProps}
        {...highlightProps}
        rowKey="payment_id"
        onRow={(record) => ({
          onDoubleClick: () => {
            show("payments", record.payment_id);
          },
        })}
      >
        <Table.Column dataIndex="payment_id" title="Payment ID" sorter />
        <Table.Column dataIndex="order_id" title="Order" render={(_, r: any) => orderMap[r?.order_id] ?? r?.order_id} />
        <Table.Column dataIndex="type_paid_id" title="Payment Type" render={(_, r: any) => typeMap[r?.type_paid_id] ?? r?.type_paid_id} />
        <Table.Column dataIndex="amount" title="Amount" sorter />
        <Table.Column dataIndex="payment_date" title="Payment Date" sorter />
        <Table.Column dataIndex="notes" title="Notes" />
        <Table.Column dataIndex="ref_key_1c" title="Ref Key 1C" />
        <Table.Column
          title="Действия"
          render={(_, record: any) => (
            <Space>
              <ShowButton hideText size="small" recordItemId={record.payment_id} />
              <EditButton hideText size="small" recordItemId={record.payment_id} />
            </Space>
          )}
        />
      </Table>
    </List>
  );
};

