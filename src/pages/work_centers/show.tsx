import { IResourceComponentsProps, useShow } from "@refinedev/core";
import { Show, TextField, DateField } from "@refinedev/antd";
import { Typography, Badge, Row, Col, Divider } from "antd";
import { DISPLAY_DATE_TIME_SECONDS_FORMAT } from "../../utils/dateFormat";
import { useCurrentRecordTabTitle } from "../../utils/recordTitle";
import { ReferenceSortOrderShow } from "../../components/ReferenceSortOrder";

const { Title } = Typography;

export const WorkCenterShow: React.FC<IResourceComponentsProps> = () => {
  const { queryResult } = useShow();
  const { data } = queryResult;
  const record = data?.data;

  useCurrentRecordTabTitle(record);

  return (
    <Show title="Просмотр участка">
      <Title level={5}>Основная информация</Title>
      <Row gutter={[16, 16]}>
        <Col span={8}>
          <Title level={5}>ID</Title>
          <TextField value={record?.workcenter_id} />
        </Col>
        <Col span={8}>
          <Title level={5}>Код участка</Title>
          <TextField value={record?.workcenter_code} />
        </Col>
        <Col span={8}>
          <Title level={5}>Название участка</Title>
          <TextField value={record?.workcenter_name} />
        </Col>
      </Row>

      <Divider />

      <Row gutter={[16, 16]} style={{ marginTop: "16px" }}>
        <Col span={8}>
          <Title level={5}>Цех</Title>
          <TextField value={record?.workshop?.workshop_name || "-"} />
        </Col>
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

      <Row gutter={[16, 16]} style={{ marginTop: "16px" }}>
        <Col span={8}>
          <Title level={5}>Создано</Title>
          <DateField value={record?.created_at} format={DISPLAY_DATE_TIME_SECONDS_FORMAT} />
        </Col>
        <Col span={8}>
          <Title level={5}>Обновлено</Title>
          <DateField value={record?.updated_at} format={DISPLAY_DATE_TIME_SECONDS_FORMAT} />
        </Col>
      </Row>
      <Divider />
      <Row gutter={[16, 16]}><Col span={8}><ReferenceSortOrderShow value={record?.sort_order} /></Col></Row>
    </Show>
  );
};
