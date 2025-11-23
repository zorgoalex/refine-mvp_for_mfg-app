import { useShow, IResourceComponentsProps } from "@refinedev/core";
import { Show, TextField } from "@refinedev/antd";
import { Typography, Row, Col, Divider } from "antd";

const { Title } = Typography;

export const UnitShow: React.FC<IResourceComponentsProps> = () => {
  const { queryResult } = useShow({ meta: { idColumnName: "unit_id" } });
  const { data, isLoading } = queryResult;
  const record = data?.data;

  return (
    <Show isLoading={isLoading} title="Просмотр Единицы измерения">
      <Title level={5}>Основная информация</Title>
      <Row gutter={[16, 16]}>
        <Col span={8}>
          <Title level={5}>ID</Title>
          <TextField value={record?.unit_id} />
        </Col>
        <Col span={8}>
          <Title level={5}>Код единицы</Title>
          <TextField value={record?.unit_code} />
        </Col>
        <Col span={8}>
          <Title level={5}>Название</Title>
          <TextField value={record?.unit_name} />
        </Col>
      </Row>

      <Divider />

      <Row gutter={[16, 16]}>
        <Col span={8}>
          <Title level={5}>Обозначение единицы</Title>
          <TextField value={record?.unit_symbol} />
        </Col>
        <Col span={8}>
          <Title level={5}>Знаков после запятой</Title>
          <TextField value={record?.decimals} />
        </Col>
      </Row>

      <Divider />

      <Row gutter={[16, 16]}>
        <Col span={8}>
          <Title level={5}>Ключ 1C</Title>
          <TextField value={record?.ref_key_1c} />
        </Col>
      </Row>
    </Show>
  );
};
