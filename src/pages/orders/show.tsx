import { useShow, useList, IResourceComponentsProps } from "@refinedev/core";
import { Show } from "@refinedev/antd";
import { Button, Collapse } from "antd";
import { PrinterOutlined } from "@ant-design/icons";
import { useRef } from "react";
import { useReactToPrint } from "react-to-print";
import { OrderPrintView } from "./components/print/OrderPrintView";
import { OrderShowHeader } from "./components/sections/OrderShowHeader";
import { OrderDatesBlock } from "./components/sections/OrderDatesBlock";
import { OrderFinanceBlock } from "./components/sections/OrderFinanceBlock";
import { OrderProductionBlock } from "./components/sections/OrderProductionBlock";
import { OrderFilesBlock } from "./components/sections/OrderFilesBlock";
import { OrderMetaBlock } from "./components/sections/OrderMetaBlock";

const { Panel } = Collapse;



export const OrderShow: React.FC<IResourceComponentsProps> = () => {
  const { queryResult } = useShow({
    meta: { 
      idColumnName: "order_id",
      fields: [
        "order_id",
        "order_name",
        "client_name",
        "order_date",
        "planned_completion_date",
        "completion_date",
        "issue_date",
        "payment_date",
        "total_amount",
        "discounted_amount",
        "discount",
        "paid_amount",
        "priority",
        "order_status_name",
        "payment_status_name",
        "manager_id",
        "milling_type_name",
        "edge_type_name",
        "film_name",
        "notes",
        "parts_count",
        "total_area",
        "link_cutting_file",
        "link_cutting_image_file",
        "link_cad_file",
        "link_pdf_file",
        "ref_key_1c",
        "version",
        "delete_flag",
        "created_at",
        "updated_at",
        "created_by",
        "edited_by",
      ],
    },
  });
  const { data, isLoading } = queryResult;

  const record = data?.data;

  // Загрузка деталей заказа
  const { data: detailsData, isLoading: detailsLoading } = useList({
    resource: "order_details",
    filters: [
      {
        field: "order_id",
        operator: "eq",
        value: record?.order_id,
      },
    ],
    queryOptions: {
      enabled: !!record?.order_id,
    },
    meta: {
      fields: [
        "detail_id",
        "length",
        "width",
        "quantity",
        "area",
        "notes",
        "milling_cost_per_sqm",
        "detail_cost",
        { milling_type: ["milling_type_name"] },
        { edge_type: ["edge_type_name"] },
        { film: ["film_name"] },
      ],
    },
  });

  const details = detailsData?.data || [];

  // Ref для печати
  const printRef = useRef<HTMLDivElement>(null);

  // Функция печати
  const handlePrint = useReactToPrint({
    contentRef: printRef,
    documentTitle: `Заказ-${record?.order_id}`,
  });

  return (
    <Show
      isLoading={isLoading || detailsLoading}
      headerButtons={({ defaultButtons }) => (
        <>
          {defaultButtons}
          <Button
            type="primary"
            icon={<PrinterOutlined />}
            onClick={handlePrint}
            disabled={!record || details.length === 0}
          >
            Печать
          </Button>
        </>
      )}
    >
      {record && (
        <>
          {/* Компактная шапка заказа (Read-only summary) */}
          <OrderShowHeader record={record} details={details} />
          
          {/* Финансы */}
          <Collapse defaultActiveKey={[]} style={{ marginBottom: 16 }}>
            <Panel 
              header={<span style={{ fontSize: 14, fontWeight: 600, color: '#faad14' }}>Финансы</span>} 
              key="finance"
            >
              <OrderFinanceBlock record={record} />
            </Panel>
          </Collapse>
          
          {/* Дополнительная информация - схлопнутый блок */}
          <Collapse defaultActiveKey={[]} style={{ marginBottom: 16 }}>
            <Panel 
              header={<span style={{ fontSize: 14, fontWeight: 600 }}>Дополнительная информация</span>} 
              key="additional"
            >
              {/* Даты */}
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#52c41a', marginBottom: 8 }}>
                  Даты
                </div>
                <OrderDatesBlock record={record} />
              </div>
              
              {/* Производство */}
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#fa8c16', marginBottom: 8 }}>
                  Производство
                </div>
                <OrderProductionBlock record={record} />
              </div>
              
              {/* Файлы */}
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#722ed1', marginBottom: 8 }}>
                  Файлы
                </div>
                <OrderFilesBlock record={record} />
              </div>
              
              {/* Служебная информация */}
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#8c8c8c', marginBottom: 8 }}>
                  Служебная информация
                </div>
                <OrderMetaBlock record={record} />
              </div>
            </Panel>
          </Collapse>

          {/* Скрытый компонент для печати */}
          <OrderPrintView
            ref={printRef}
            order={{
              order_id: record.order_id,
              order_name: record.order_name,
              order_date: record.order_date,
              total_amount: record.total_amount,
              discounted_amount: record.discounted_amount,
              paid_amount: record.paid_amount,
              parts_count: record.parts_count,
              total_area: record.total_area,
              notes: record.notes,
            }}
            details={details}
            client={record.client_name ? { client_name: record.client_name } : undefined}
          />
        </>
      )}
    </Show>
  );
};
