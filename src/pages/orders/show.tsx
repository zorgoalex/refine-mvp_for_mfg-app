import { useShow, IResourceComponentsProps } from "@refinedev/core";
import { Show, TextField, DateField } from "@refinedev/antd";
import { Typography, Row, Col } from "antd";

const { Title } = Typography;

export const OrderShow: React.FC<IResourceComponentsProps> = () => {
  const { queryResult } = useShow({
    meta: { idColumnName: "order_id" },
  });
  const { data, isLoading } = queryResult;

  const record = data?.data;

  return (
    <Show isLoading={isLoading}>
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
          {record?.order_date ? <DateField value={record?.order_date} /> : <TextField value="-" />}
        </Col>
        <Col span={8}>
          <Title level={5}>Completion Date</Title>
          {record?.completion_date ? <DateField value={record?.completion_date} /> : <TextField value="-" />}
        </Col>
        <Col span={8}>
          <Title level={5}>Planned Completion Date</Title>
          {record?.planned_completion_date ? <DateField value={record?.planned_completion_date} /> : <TextField value="-" />}
        </Col>

        <Col span={8}>
          <Title level={5}>Issue Date</Title>
          {record?.issue_date ? <DateField value={record?.issue_date} /> : <TextField value="-" />}
        </Col>
        <Col span={8}>
          <Title level={5}>Payment Date</Title>
          {record?.payment_date ? <DateField value={record?.payment_date} /> : <TextField value="-" />}
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
          <Title level={5}>Parts Count</Title>
          <TextField value={record?.parts_count} />
        </Col>

        <Col span={8}>
          <Title level={5}>Total Area</Title>
          <TextField value={record?.total_area} />
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
          <Title level={5}>Film</Title>
          <TextField value={record?.film_name} />
        </Col>
        <Col span={8}>
          <Title level={5}>Edge Type</Title>
          <TextField value={record?.edge_type_name} />
        </Col>
        <Col span={8}>
          <Title level={5}>Manager ID</Title>
          <TextField value={record?.manager_id} />
        </Col>

        <Col span={8}>
          <Title level={5}>Created By</Title>
          <TextField value={record?.created_by} />
        </Col>
        <Col span={8}>
          <Title level={5}>Created At</Title>
          {record?.created_at ? <DateField value={record?.created_at} /> : <TextField value="-" />}
        </Col>
        <Col span={8}>
          <Title level={5}>Edited By</Title>
          <TextField value={record?.edited_by} />
        </Col>

        <Col span={8}>
          <Title level={5}>Updated At</Title>
          {record?.updated_at ? <DateField value={record?.updated_at} /> : <TextField value="-" />}
        </Col>
      </Row>
    </Show>
  );
};
