import { useShow, IResourceComponentsProps } from "@refinedev/core";
import { Show, TextField, DateField } from "@refinedev/antd";
import { Typography, Badge, Row, Col, Divider } from "antd";

const { Title } = Typography;

export const MillingTypeShow: React.FC<IResourceComponentsProps> = () => {
  const { queryResult } = useShow({
    meta: { idColumnName: "milling_type_id" },
  });
  const { data, isLoading } = queryResult;

  const record = data?.data;

  return (
    <Show isLoading={isLoading} title="Просмотр типа фрезеровки">
      <Title level={5}>Основная информация</Title>
      <Row gutter={[16, 16]}>
        <Col span={8}>
          <Title level={5}>ID</Title>
          <TextField value={record?.milling_type_id} />
        </Col>
        <Col span={8}>
          <Title level={5}>Тип фрезеровки</Title>
          <TextField value={record?.milling_type_name} />
        </Col>
        <Col span={8}>
          <Title level={5}>Стоимость за м²</Title>
          <TextField value={record?.cost_per_sqm} />
        </Col>
      </Row>

      <Divider />

      <Row gutter={[16, 16]}>
        <Col span={8}>
          <Title level={5}>1C-key</Title>
          <TextField value={record?.ref_key_1c} />
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


