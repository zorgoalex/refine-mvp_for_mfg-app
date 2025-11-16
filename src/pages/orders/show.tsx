import { useShow, useList, IResourceComponentsProps } from "@refinedev/core";
import { Show, TextField, DateField } from "@refinedev/antd";
import { Typography, Row, Col, Divider, Button } from "antd";
import { PrinterOutlined } from "@ant-design/icons";
import { useRef } from "react";
import { useReactToPrint } from "react-to-print";
import { OrderPrintView } from "./components/print/OrderPrintView";

const { Title, Paragraph, Link } = Typography;

const renderDate = (value?: string | Date | null) =>
  value ? <DateField value={value} /> : <TextField value="-" />;

const renderText = (value?: string | number | null) => (
  <TextField value={value ?? "-"} />
);

const renderLink = (href?: string | null) =>
  href ? (
    <Link href={href} target="_blank" rel="noopener noreferrer">
      {href}
    </Link>
  ) : (
    <TextField value="-" />
  );

const renderBoolean = (value?: boolean | null) =>
  value ? "Да" : "Нет";

export const OrderShow: React.FC<IResourceComponentsProps> = () => {
  const { queryResult } = useShow({
    meta: { idColumnName: "order_id" },
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
      <Row gutter={[16, 8]}>
        <Col span={8}>
          <Title level={5}>Order ID</Title>
          <TextField value={record?.order_id} />
        </Col>
        <Col span={8}>
          <Title level={5}>Order Name</Title>
          <TextField value={record?.order_name} />
        </Col>
        <Col span={8}>
          <Title level={5}>Client</Title>
          <TextField value={record?.client_name} />
        </Col>

        <Col span={8}>
          <Title level={5}>Order Date</Title>
          {renderDate(record?.order_date)}
        </Col>
        <Col span={8}>
          <Title level={5}>Completion Date</Title>
          {renderDate(record?.completion_date)}
        </Col>
        <Col span={8}>
          <Title level={5}>Planned Completion Date</Title>
          {renderDate(record?.planned_completion_date)}
        </Col>

        <Col span={8}>
          <Title level={5}>Issue Date</Title>
          {renderDate(record?.issue_date)}
        </Col>
        <Col span={8}>
          <Title level={5}>Payment Date</Title>
          {renderDate(record?.payment_date)}
        </Col>
        <Col span={8}>
          <Title level={5}>Priority</Title>
          <TextField value={record?.priority} />
        </Col>

        <Col span={8}>
          <Title level={5}>Order Status</Title>
          <TextField value={record?.order_status_name} />
        </Col>
        <Col span={8}>
          <Title level={5}>Payment Status</Title>
          <TextField value={record?.payment_status_name} />
        </Col>
        <Col span={8}>
          <Title level={5}>Manager</Title>
          {renderText(record?.manager_id)}
        </Col>

        <Col span={8}>
          <Title level={5}>Parts Count</Title>
          {renderText(record?.parts_count)}
        </Col>
        <Col span={8}>
          <Title level={5}>Total Area</Title>
          {renderText(record?.total_area)}
        </Col>
        <Col span={8}>
          <Title level={5}>Total Amount</Title>
          {renderText(record?.total_amount)}
        </Col>

        <Col span={8}>
          <Title level={5}>Discount (%)</Title>
          {renderText(record?.discount)}
        </Col>
        <Col span={8}>
          <Title level={5}>Discounted Amount</Title>
          {renderText(record?.discounted_amount)}
        </Col>
        <Col span={8}>
          <Title level={5}>Paid Amount</Title>
          {renderText(record?.paid_amount)}
        </Col>

        <Col span={8}>
          <Title level={5}>Material</Title>
          <TextField value={record?.material_name} />
        </Col>
        <Col span={8}>
          <Title level={5}>Milling Type</Title>
          <TextField value={record?.milling_type_name} />
        </Col>
        <Col span={8}>
          <Title level={5}>Edge Type</Title>
          <TextField value={record?.edge_type_name} />
        </Col>
        <Col span={8}>
          <Title level={5}>Film</Title>
          <TextField value={record?.film_name} />
        </Col>
      </Row>

      <Divider>Файлы</Divider>
      <Row gutter={[16, 8]}>
        <Col span={12}>
          <Title level={5}>Link Cutting File</Title>
          {renderLink(record?.link_cutting_file)}
        </Col>
        <Col span={12}>
          <Title level={5}>Link Cutting Image File</Title>
          {renderLink(record?.link_cutting_image_file)}
        </Col>
        <Col span={12}>
          <Title level={5}>Link CAD File</Title>
          {renderLink(record?.link_cad_file)}
        </Col>
        <Col span={12}>
          <Title level={5}>Link PDF File</Title>
          {renderLink(record?.link_pdf_file)}
        </Col>
      </Row>

      <Divider>Дополнительно</Divider>
      <Row gutter={[16, 8]}>
        <Col span={12}>
          <Title level={5}>Reference (1C)</Title>
          {renderText(record?.ref_key_1c)}
        </Col>
        <Col span={12}>
          <Title level={5}>Version</Title>
          {renderText(record?.version)}
        </Col>
        <Col span={8}>
          <Title level={5}>Delete Flag</Title>
          <TextField value={renderBoolean(record?.delete_flag)} />
        </Col>
        <Col span={8}>
          <Title level={5}>Created By</Title>
          {renderText(record?.created_by)}
        </Col>
        <Col span={8}>
          <Title level={5}>Edited By</Title>
          {renderText(record?.edited_by)}
        </Col>
        <Col span={8}>
          <Title level={5}>Created At</Title>
          {renderDate(record?.created_at)}
        </Col>
        <Col span={8}>
          <Title level={5}>Updated At</Title>
          {renderDate(record?.updated_at)}
        </Col>
        <Col span={24}>
          <Title level={5}>Notes</Title>
          <Paragraph>{record?.notes || "—"}</Paragraph>
        </Col>
      </Row>

      {/* Скрытый компонент для печати */}
      {record && (
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
          }}
          details={details}
          client={record.client_name ? { client_name: record.client_name } : undefined}
        />
      )}
    </Show>
  );
};
