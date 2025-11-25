import { IResourceComponentsProps, useMany, useNavigation } from "@refinedev/core";
import { useTable, ShowButton, EditButton, List, useSelect } from "@refinedev/antd";
import { Space, Table, Button, Form, Row, Col, Select, DatePicker, InputNumber, Card, Typography } from "antd";
import { useMemo, useState } from "react";
import { FilterOutlined, ClearOutlined, CheckCircleOutlined } from "@ant-design/icons";
import { useHighlightRow } from "../../hooks/useHighlightRow";
import dayjs from "dayjs";
import "./list.css";

const { RangePicker } = DatePicker;
const { Text } = Typography;

export const PaymentList: React.FC<IResourceComponentsProps> = () => {
  const [form] = Form.useForm();
  const [filtersVisible, setFiltersVisible] = useState(false);
  const [showResultCount, setShowResultCount] = useState(false);

  const { tableProps, filters, setFilters } = useTable({
    syncWithLocation: true,
    sorters: { initial: [{ field: "payment_id", order: "desc" }] },
    pagination: { pageSize: 10 },
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
    (ordersData?.data || []).forEach((o: any) => (map[o.order_id] = o.order_name ?? o.order_id));
    return map;
  }, [ordersData]);

  const typeMap = useMemo(() => {
    const map: Record<string | number, string> = {};
    (typesData?.data || []).forEach((t: any) => (map[t.type_paid_id] = t.type_paid_name));
    return map;
  }, [typesData]);

  // useSelect для справочников в фильтрах
  const { selectProps: orderSelectProps } = useSelect({
    resource: "orders",
    optionLabel: "order_name",
    optionValue: "order_id",
  });

  const { selectProps: typeSelectProps } = useSelect({
    resource: "payment_types",
    optionLabel: "type_paid_name",
    optionValue: "type_paid_id",
  });

  const { selectProps: userSelectProps } = useSelect({
    resource: "users",
    optionLabel: "username",
    optionValue: "user_id",
  });

  // Применение фильтров
  const handleFilter = (values: any) => {
    const newFilters: any[] = [];

    // Проверяем, что значение не пустое (не undefined, не null, не пустая строка)
    const hasValue = (val: any) => val !== undefined && val !== null && val !== "";

    if (hasValue(values.order_id)) {
      newFilters.push({ field: "order_id", operator: "eq", value: values.order_id });
    }

    if (values.date_range && Array.isArray(values.date_range) && values.date_range.length === 2) {
      newFilters.push({
        field: "payment_date",
        operator: "gte",
        value: values.date_range[0].format("YYYY-MM-DD"),
      });
      newFilters.push({
        field: "payment_date",
        operator: "lte",
        value: values.date_range[1].format("YYYY-MM-DD"),
      });
    }

    if (hasValue(values.amount_min)) {
      newFilters.push({ field: "amount", operator: "gte", value: values.amount_min });
    }

    if (hasValue(values.amount_max)) {
      newFilters.push({ field: "amount", operator: "lte", value: values.amount_max });
    }

    if (hasValue(values.type_paid_id)) {
      newFilters.push({ field: "type_paid_id", operator: "eq", value: values.type_paid_id });
    }

    if (hasValue(values.created_by)) {
      newFilters.push({ field: "created_by", operator: "eq", value: values.created_by });
    }

    setFilters(newFilters, "replace");
    setShowResultCount(true);
  };

  // Сброс фильтров
  const handleClearFilters = () => {
    form.resetFields();
    setFilters([], "replace");
    setShowResultCount(false);
  };

  // Получаем общее количество записей
  const totalRecords = tableProps?.pagination?.total || 0;

  return (
    <List
      title="Платежи"
      headerButtons={({ defaultButtons }) => (
        <>
          <Button
            type={filtersVisible ? "primary" : "default"}
            icon={<FilterOutlined />}
            onClick={() => setFiltersVisible(!filtersVisible)}
          >
            {filtersVisible ? "Скрыть фильтры" : "Фильтры"}
          </Button>
          {defaultButtons}
        </>
      )}
    >
      {filtersVisible && (
        <Card style={{ marginBottom: 16 }}>
          <Form form={form} layout="vertical" onFinish={handleFilter}>
            <Row gutter={16}>
              <Col xs={24} sm={12} md={8} lg={4}>
                <Form.Item name="order_id" label="Заказ">
                  <Select
                    {...orderSelectProps}
                    allowClear
                    placeholder="Выберите заказ"
                    showSearch
                    filterOption={(input, option) =>
                      (option?.label ?? "").toLowerCase().includes(input.toLowerCase())
                    }
                  />
                </Form.Item>
              </Col>
              <Col xs={24} sm={12} md={8} lg={6}>
                <Form.Item name="date_range" label="Период дат">
                  <RangePicker style={{ width: "100%" }} format="DD.MM.YYYY" />
                </Form.Item>
              </Col>
              <Col xs={24} sm={12} md={8} lg={4}>
                <Form.Item name="amount_min" label="Сумма от">
                  <InputNumber
                    style={{ width: "100%" }}
                    placeholder="Мин"
                    min={0}
                    precision={0}
                  />
                </Form.Item>
              </Col>
              <Col xs={24} sm={12} md={8} lg={4}>
                <Form.Item name="amount_max" label="Сумма до">
                  <InputNumber
                    style={{ width: "100%" }}
                    placeholder="Макс"
                    min={0}
                    precision={0}
                  />
                </Form.Item>
              </Col>
              <Col xs={24} sm={12} md={8} lg={3}>
                <Form.Item name="type_paid_id" label="Тип оплаты">
                  <Select
                    {...typeSelectProps}
                    allowClear
                    placeholder="Тип"
                  />
                </Form.Item>
              </Col>
              <Col xs={24} sm={12} md={8} lg={3}>
                <Form.Item name="created_by" label="Создал">
                  <Select
                    {...userSelectProps}
                    allowClear
                    placeholder="Пользователь"
                    showSearch
                    filterOption={(input, option) =>
                      (option?.label ?? "").toLowerCase().includes(input.toLowerCase())
                    }
                  />
                </Form.Item>
              </Col>
            </Row>
            <Row>
              <Col>
                <Space size="large">
                  <Space>
                    <Button type="primary" htmlType="submit" icon={<FilterOutlined />}>
                      Применить
                    </Button>
                    <Button onClick={handleClearFilters} icon={<ClearOutlined />}>
                      Сбросить
                    </Button>
                  </Space>
                  {showResultCount && (
                    <Text strong style={{ color: '#52c41a', fontSize: '14px' }}>
                      <CheckCircleOutlined /> Найдено записей: {totalRecords}
                    </Text>
                  )}
                </Space>
              </Col>
            </Row>
          </Form>
        </Card>
      )}
      <Table
        {...tableProps}
        {...highlightProps}
        rowKey="payment_id"
        onRow={(record: any) => ({
          onDoubleClick: () => {
            show("payments", record.payment_id);
          },
        })}
      >
        <Table.Column dataIndex="payment_id" title="id" sorter />
        <Table.Column
          dataIndex="order_id"
          title="Заказ"
          render={(_, r: any) => orderMap[r?.order_id] ?? r?.order_id}
        />
        <Table.Column
          dataIndex="type_paid_id"
          title="Тип оплаты"
          render={(_, r: any) => typeMap[r?.type_paid_id] ?? r?.type_paid_id}
        />
        <Table.Column dataIndex="amount" title="Сумма" sorter />
        <Table.Column dataIndex="payment_date" title="Дата платежа" sorter />
        <Table.Column dataIndex="notes" title="Примечание" />
        <Table.Column dataIndex="ref_key_1c" title="1C-key" />
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
