import { IResourceComponentsProps, useShow } from "@refinedev/core";
import { Show, TextField, DateField } from "@refinedev/antd";
import { Typography, Badge, Row, Col, Divider } from "antd";
import { DISPLAY_DATE_TIME_SECONDS_FORMAT } from "../../utils/dateFormat";
import { useCurrentRecordTabTitle } from "../../utils/recordTitle";
import { ReferenceSortOrderShow } from "../../components/ReferenceSortOrder";

const { Title } = Typography;

export const WorkshopShow: React.FC<IResourceComponentsProps> = () => {
  const { queryResult } = useShow();
  const { data } = queryResult;
  const record = data?.data;

  useCurrentRecordTabTitle(record);

  return (
    <Show title="Просмотр цеха">
      <Title level={5}>Основная информация</Title>
      <Row gutter={[16, 16]}>
        <Col span={8}>
          <Title level={5}>ID</Title>
          <TextField value={record?.workshop_id} />
        </Col>
        <Col span={8}>
          <Title level={5}>Название цеха</Title>
          <TextField value={record?.workshop_name} />
        </Col>
        <Col span={8}>
          <Title level={5}>Адрес цеха</Title>
          <TextField value={record?.address || "-"} />
        </Col>
      </Row>

      <Divider />

      <Row gutter={[16, 16]}>
        <Col span={8}>
          <Title level={5}>Ответственный</Title>
          <TextField value={record?.employee?.full_name || "-"} />
        </Col>
        <Col span={8}>
          <Title level={5}>1C-key</Title>
          <TextField value={record?.ref_key_1c || "-"} />
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
