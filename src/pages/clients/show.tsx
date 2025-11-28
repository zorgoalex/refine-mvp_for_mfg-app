import { useShow, useList, IResourceComponentsProps } from "@refinedev/core";
import { Show, TextField, DateField } from "@refinedev/antd";
import { Typography, Badge, Row, Col, Divider, Table, Tag, Space } from "antd";
import { PhoneOutlined, StarFilled } from "@ant-design/icons";
import { ClientPhone, PhoneType, PHONE_TYPE_LABELS } from "../../types/clients";

const { Title, Text } = Typography;

export const ClientShow: React.FC<IResourceComponentsProps> = () => {
  const { queryResult } = useShow({
    meta: { idColumnName: "client_id" },
  });
  const { data, isLoading } = queryResult;

  const record = data?.data;

  // Fetch client phones
  const { data: phonesData, isLoading: phonesLoading } = useList<ClientPhone>({
    resource: "client_phones",
    filters: [
      {
        field: "client_id",
        operator: "eq",
        value: record?.client_id,
      },
    ],
    pagination: { pageSize: 100 },
    queryOptions: {
      enabled: !!record?.client_id,
    },
  });

  const phones = phonesData?.data || [];

  const phoneColumns = [
    {
      title: "Телефон",
      dataIndex: "phone_number",
      key: "phone_number",
      render: (value: string, record: ClientPhone) => (
        <Space>
          <PhoneOutlined />
          <Text>{value}</Text>
          {record.is_primary && (
            <Tag color="gold" icon={<StarFilled />}>
              Основной
            </Tag>
          )}
        </Space>
      ),
    },
    {
      title: "Тип",
      dataIndex: "phone_type",
      key: "phone_type",
      render: (value: PhoneType) => PHONE_TYPE_LABELS[value] || value,
    },
  ];

  return (
    <Show isLoading={isLoading} title="Просмотр Клиента">
      <Title level={5}>Основная информация</Title>
      <Row gutter={[16, 16]}>
        <Col span={8}>
          <Title level={5}>ID</Title>
          <TextField value={record?.client_id} />
        </Col>
        <Col span={8}>
          <Title level={5}>Имя клиента</Title>
          <TextField value={record?.client_name} />
        </Col>
        <Col span={8}>
          <Title level={5}>Активен</Title>
          <Badge
            status={record?.is_active ? "success" : "default"}
            text={record?.is_active ? "Активен" : "Неактивен"}
          />
        </Col>
      </Row>

      <Divider />

      {/* Phone numbers section */}
      <Title level={5}>Телефоны</Title>
      <Table
        dataSource={phones}
        columns={phoneColumns}
        rowKey="phone_id"
        size="small"
        pagination={false}
        loading={phonesLoading}
        locale={{ emptyText: "Нет телефонов" }}
        style={{ marginBottom: 16 }}
      />

      <Divider />

      <Row gutter={[16, 16]}>
        <Col span={24}>
          <Title level={5}>Примечание</Title>
          <TextField value={record?.notes || "-"} />
        </Col>
      </Row>

      <Divider />

      <Row gutter={[16, 16]}>
        <Col span={8}>
          <Title level={5}>Ключ 1C</Title>
          <TextField value={record?.ref_key_1c} />
        </Col>
      </Row>

      <Divider />

      <Row gutter={[16, 16]}>
        <Col span={8}>
          <Title level={5}>Создан</Title>
          <TextField value={record?.created_by || "-"} />
        </Col>
        <Col span={8}>
          <Title level={5}>Изменён</Title>
          <TextField value={record?.edited_by || "-"} />
        </Col>
      </Row>

      <Divider />

      <Row gutter={[16, 16]}>
        <Col span={8}>
          <Title level={5}>Создано</Title>
          <DateField value={record?.created_at} format="YYYY-MM-DD HH:mm:ss" />
        </Col>
        <Col span={8}>
          <Title level={5}>Обновлено</Title>
          <DateField value={record?.updated_at} format="YYYY-MM-DD HH:mm:ss" />
        </Col>
      </Row>
    </Show>
  );
};
