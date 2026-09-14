import { Table } from '../../ui/tooltipDelay';
import { IResourceComponentsProps, useMany, useNavigation } from "@refinedev/core";
import { ShowButton, EditButton } from "@refinedev/antd";
import { usePersistentTable as useTable } from "../../hooks/usePersistentTable";
import { Space, Badge, Button, Card, Col, Form, Input, InputNumber, Row, Select } from "antd";
import { useEffect, useMemo, useState } from "react";
import { ClearOutlined, FilterOutlined, SearchOutlined } from "@ant-design/icons";
import { useSelect } from "../../ui/refineSelect";
import { useHighlightRow } from "../../hooks/useHighlightRow";
import { LocalizedList } from "../../components/LocalizedList";
import { ReferenceSortOrderColumn } from "../../components/ReferenceSortOrder";
import { buildFilmFilters, FILM_KEY_PATTERN, hasFilmFieldFilters, readFilmFilters, type FilmFilterValues } from "./filmFilters";

export const FilmList: React.FC<IResourceComponentsProps> = () => {
  const [filtersVisible, setFiltersVisible] = useState(false);
  const [form] = Form.useForm<FilmFilterValues>();
  const { tableProps, filters, setFilters, setCurrent } = useTable({
    resource: "films",
    syncWithLocation: true,
    sorters: {
      initial: [{ field: "sort_order", order: "asc" }, { field: "film_id", order: "asc" }],
    },
  });
  const appliedFilters = useMemo(() => readFilmFilters(filters), [filters]);
  const [search, setSearch] = useState(appliedFilters.film_name ?? "");
  const hasFieldFilters = hasFilmFieldFilters(appliedFilters);

  useEffect(() => setSearch(appliedFilters.film_name ?? ""), [appliedFilters.film_name]);
  useEffect(() => {
    if (filtersVisible) form.setFieldsValue(appliedFilters);
  }, [appliedFilters, filtersVisible, form]);

  const applyFilters = (values: FilmFilterValues) => {
    setFilters(buildFilmFilters(values), "replace");
    setCurrent(1);
  };
  const resetFilters = () => {
    form.resetFields();
    setSearch("");
    applyFilters({});
  };
  const { selectProps: typeSelectProps } = useSelect({
    resource: "film_types",
    optionLabel: "film_type_name",
    optionValue: "film_type_id",
    defaultValue: appliedFilters.film_type_id,
    filters: [{ field: "is_active", operator: "in", value: [true, false] }],
    queryOptions: { enabled: filtersVisible },
  });
  const { selectProps: vendorSelectProps } = useSelect({
    resource: "vendors",
    optionLabel: "vendor_name",
    optionValue: "vendor_id",
    defaultValue: appliedFilters.vendor_id,
    filters: [{ field: "is_active", operator: "in", value: [true, false] }],
    queryOptions: { enabled: filtersVisible },
  });

  const { highlightProps } = useHighlightRow(
    "film_id",
    tableProps.dataSource,
  );
  const { show } = useNavigation();

  const typeIds = useMemo(
    () =>
      Array.from(
        new Set(
          ((tableProps?.dataSource as any[]) || [])
            .map((i) => i?.film_type_id)
            .filter((v) => v !== undefined && v !== null),
        ),
      ),
    [tableProps?.dataSource],
  );

  const vendorIds = useMemo(
    () =>
      Array.from(
        new Set(
          ((tableProps?.dataSource as any[]) || [])
            .map((i) => i?.vendor_id)
            .filter((v) => v !== undefined && v !== null),
        ),
      ),
    [tableProps?.dataSource],
  );

  const { data: typesData } = useMany({
    resource: "film_types",
    ids: typeIds,
    queryOptions: { enabled: typeIds.length > 0 },
  });

  const { data: vendorsData } = useMany({
    resource: "vendors",
    ids: vendorIds,
    queryOptions: { enabled: vendorIds.length > 0 },
  });

  const typeMap = useMemo(() => {
    const map: Record<string | number, string> = {};
    (typesData?.data || []).forEach((t: any) => {
      map[t.film_type_id] = t.film_type_name;
    });
    return map;
  }, [typesData]);

  const vendorMap = useMemo(() => {
    const map: Record<string | number, string> = {};
    (vendorsData?.data || []).forEach((v: any) => {
      map[v.vendor_id] = v.vendor_name;
    });
    return map;
  }, [vendorsData]);

  return (
    <LocalizedList title="Плёнки">
      <Space wrap style={{ marginBottom: 16, width: "100%" }}>
        <Input.Search
          aria-label="Поиск плёнок по названию"
          placeholder="Поиск по названию"
          allowClear
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          onSearch={(value) => applyFilters({ ...appliedFilters, film_name: value })}
          style={{ width: 280, maxWidth: "100%" }}
        />
        <Button
          icon={<FilterOutlined aria-hidden />}
          type={filtersVisible || hasFieldFilters ? "primary" : "default"}
          aria-expanded={filtersVisible}
          aria-controls="films-filters"
          onClick={() => setFiltersVisible((visible) => !visible)}
        >
          {filtersVisible ? "Скрыть фильтры" : hasFieldFilters ? "Фильтры активны" : "Фильтры"}
        </Button>
      </Space>
      {filtersVisible && (
        <section id="films-filters" aria-label="Фильтры плёнок">
          <Card title="Фильтры" style={{ marginBottom: 16 }}>
            <Form form={form} layout="vertical" initialValues={appliedFilters}
              onFinish={(values) => applyFilters({ ...values, film_name: search })}>
              <Row gutter={16}>
                <Col xs={24} sm={12} lg={6}>
                  <Form.Item name="film_id" label="ID">
                    <InputNumber min={1} precision={0} placeholder="ID плёнки" style={{ width: "100%" }} />
                  </Form.Item>
                </Col>
                <Col xs={24} sm={12} lg={6}>
                  <Form.Item name="film_type_id" label="Тип плёнки">
                    <Select {...typeSelectProps} allowClear placeholder="Все типы" />
                  </Form.Item>
                </Col>
                <Col xs={24} sm={12} lg={6}>
                  <Form.Item name="vendor_id" label="Поставщик плёнки">
                    <Select {...vendorSelectProps} allowClear placeholder="Все поставщики" />
                  </Form.Item>
                </Col>
                <Col xs={24} sm={12} lg={6}>
                  <Form.Item name="film_texture" label="Фактура">
                    <Select allowClear placeholder="Любая" options={[
                      { value: "yes", label: "С фактурой" }, { value: "no", label: "Без фактуры" },
                    ]} />
                  </Form.Item>
                </Col>
                <Col xs={24} sm={12} lg={6}>
                  <Form.Item name="is_active" label="Активность">
                    <Select options={[
                      { value: "active", label: "Активные" },
                      { value: "inactive", label: "Неактивные" },
                      { value: "all", label: "Все" },
                    ]} />
                  </Form.Item>
                </Col>
                <Col xs={24} sm={12} lg={6}>
                  <Form.Item name="ref_key_1c" label="Ключ 1С" rules={[{
                    pattern: FILM_KEY_PATTERN,
                    transform: (value: string) => value?.trim(),
                    message: "Введите полный UUID ключа 1С",
                  }]}>
                    <Input allowClear placeholder="Полный ключ 1С" />
                  </Form.Item>
                </Col>
                <Col xs={24} sm={12} lg={6}>
                  <Form.Item name="sort_order" label="Порядок">
                    <InputNumber precision={0} placeholder="Порядок сортировки" style={{ width: "100%" }} />
                  </Form.Item>
                </Col>
              </Row>
              <Space wrap>
                <Button type="primary" htmlType="submit" icon={<SearchOutlined aria-hidden />}>Применить</Button>
                <Button icon={<ClearOutlined aria-hidden />} onClick={resetFilters}>Сбросить</Button>
              </Space>
            </Form>
          </Card>
        </section>
      )}
      <Table
        {...tableProps}
        {...highlightProps}
        rowKey="film_id"
        onRow={(record) => ({
          onDoubleClick: () => {
            show("films", record.film_id);
          },
        })}
      >
        <Table.Column dataIndex="film_id" title="id" sorter />
        <ReferenceSortOrderColumn />
        <Table.Column dataIndex="film_name" title="Название" sorter />
        <Table.Column
          dataIndex="film_type_id"
          title="Тип плёнки"
          render={(_, record: any) =>
            typeMap[record?.film_type_id] ?? record?.film_type_id
          }
        />
        <Table.Column
          dataIndex="vendor_id"
          title="Поставщик плёнки"
          render={(_, record: any) =>
            vendorMap[record?.vendor_id] ?? record?.vendor_id
          }
        />
        <Table.Column dataIndex="film_texture" title="Фактура" render={(value: boolean) => value ? "Да" : "Нет"} />
        <Table.Column dataIndex="ref_key_1c" title="1C-key" />
        <Table.Column
          dataIndex="is_active"
          title="Активен"
          render={(value: boolean) => (
            <Badge
              status={value ? "success" : "default"}
              text={value ? "Активен" : "Неактивен"}
            />
          )}
        />
        <Table.Column
          title="Действия"
          render={(_, record: any) => (
            <Space size={4}>
              <ShowButton
                hideText
                size="small"
                recordItemId={record.film_id}
              />
              <EditButton
                hideText
                size="small"
                recordItemId={record.film_id}
              />
            </Space>
          )}
        />
      </Table>
    </LocalizedList>
  );
};
