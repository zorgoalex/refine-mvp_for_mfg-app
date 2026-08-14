import { IResourceComponentsProps, useShow } from "@refinedev/core";
import { Show, TextField, DateField } from "@refinedev/antd";
import { Typography, Badge, Row, Col, Divider } from "antd";
import { DISPLAY_DATE_TIME_SECONDS_FORMAT } from "../../utils/dateFormat";
import { useCurrentRecordTabTitle } from "../../utils/recordTitle";

const { Title } = Typography;

export const UserShow: React.FC<IResourceComponentsProps> = () => {
  const { queryResult } = useShow();
  const { data } = queryResult;
  const record = data?.data;

  useCurrentRecordTabTitle(record);

  return (
    <Show title="Просмотр Пользователя">
      <Title level={5}>Основная информация</Title>
      <Row gutter={[16, 16]}>
        <Col span={8}>
          <Title level={5}>ID</Title>
          <TextField value={record?.user_id} />
        </Col>
        <Col span={8}>
          <Title level={5}>Логин</Title>
          <TextField value={record?.username} />
        </Col>
        <Col span={8}>
          <Title level={5}>Email</Title>
          <TextField value={record?.email || "-"} />
        </Col>
      </Row>

      <Divider />

      <Row gutter={[16, 16]}>
        <Col span={8}>
          <Title level={5}>Полное имя</Title>
          <TextField value={record?.full_name || "-"} />
        </Col>
        <Col span={8}>
          <Title level={5}>Роль</Title>
          <TextField value={formatUserRole(record)} />
        </Col>
      </Row>

      <Divider />

      <Row gutter={[16, 16]}>
        <Col span={8}>
          <Title level={5}>Активен</Title>
          <Badge
            status={record?.is_active ? "success" : "default"}
            text={record?.is_active ? "Активен" : "Неактивен"}
          />
        </Col>
        <Col span={8}>
          <Title level={5}>Последний вход</Title>
          {record?.last_login_at ? (
            <DateField value={record.last_login_at} format={DISPLAY_DATE_TIME_SECONDS_FORMAT} />
          ) : (
            <TextField value="-" />
          )}
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

    </Show>
  );
};

function formatUserRole(record: any): string {
  if (typeof record?.role === "string") {
    return record.role_name || record.role;
  }

  return record?.role?.role_name || record?.role_name || "-";
}
