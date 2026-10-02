import { Table, Tooltip } from '../../ui/tooltipDelay';
import { IResourceComponentsProps, useMany, useNavigation, useGetIdentity } from "@refinedev/core";
import { ShowButton, EditButton } from "@refinedev/antd";
import { usePersistentTable as useTable } from "../../hooks/usePersistentTable";
import { Space, Badge, Button, Card, Col, Form, Input, InputNumber, Row, Select } from "antd";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ClearOutlined, FilterOutlined, SearchOutlined } from "@ant-design/icons";
import { useSelect } from "../../ui/refineSelect";
import { useHighlightRow } from "../../hooks/useHighlightRow";
import { LocalizedList } from "../../components/LocalizedList";
import { buildFilmFilters, FILM_KEY_PATTERN, hasFilmFieldFilters, readFilmFilters, type FilmFilterValues } from "./filmFilters";
import { FilmSearch } from "./FilmSearch";
import { useNavigate } from 'react-router-dom';
import { getLoadedRuntimeConfig } from '../../config/runtimeConfig';
import { useRefHeight, useSelectorHeight, useStickyBottom } from '../../hooks/useElementHeight';
import './films.css';

// Узкие колонки фиксированной ширины: список помещается без горизонтальной прокрутки, «Название» берёт остаток.
// Сумма 960px: при ширине окна 1440 «Названию» остаётся ~200px.
const WIDTH = { id: 56, sort: 60, nomenclatureType: 84, category: 84, note: 110, filmType: 84, vendor: 100, texture: 60, key: 90, active: 92, actions: 76, catalog: 64 } as const;

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
  const navigate = useNavigate();
  const { data: identity } = useGetIdentity<{ permissions?: string[] }>();
  const canManageCatalog = (identity?.permissions ?? []).includes('references.manage');
  // Липкие блоки: шапка списка — под лентой вкладок, шапка таблицы — под ней, пагинация — над подвалом приложения.
  const headRef = useRef<HTMLDivElement>(null);
  const tabsHeight = useStickyBottom('.workspace-tabs');
  const footerHeight = useSelectorHeight('.ant-layout-footer');
  const headHeight = useRefHeight(headRef);

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
  const canonicalIds = useMemo(() => Array.from(new Set(((tableProps?.dataSource as Array<Record<string, unknown>>) ?? [])
    .map((row) => row.canonical_film_id).filter((id): id is number => typeof id === 'number'))), [tableProps?.dataSource]);
  const { data: canonData } = useMany({ resource: 'films', ids: canonicalIds, queryOptions: { enabled: canonicalIds.length > 0 } });
  const canonicalMap = useMemo(() => Object.fromEntries((canonData?.data ?? []).map((film: any) => [film.film_id, film.film_name])), [canonData]);

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
      <div className="films-list" style={{ '--films-list-bottom': `${footerHeight}px` } as CSSProperties}>
      <div ref={headRef} className="films-list__head" style={{ top: tabsHeight }}>
      <Space wrap style={{ width: "100%" }}>
        {getLoadedRuntimeConfig()?.features?.filmCatalogImport === true && canManageCatalog && <Button onClick={() => navigate('/films/catalog-import')}>Импорт каталога 1С</Button>}
        <FilmSearch
          value={search}
          filters={appliedFilters}
          onChange={setSearch}
          onSearch={(value) => applyFilters({ ...appliedFilters, film_name: value })}
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
          <Card title="Фильтры" size="small" style={{ marginTop: 8 }}>
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
                <Col xs={24} sm={12} lg={6}><Form.Item name="nomenclature_type" label="Тип номенклатуры"><Input allowClear /></Form.Item></Col>
                <Col xs={24} sm={12} lg={6}><Form.Item name="nomenclature_category" label="Категория номенклатуры"><Input allowClear /></Form.Item></Col>
              </Row>
              <Space wrap>
                <Button type="primary" htmlType="submit" icon={<SearchOutlined aria-hidden />}>Применить</Button>
                <Button icon={<ClearOutlined aria-hidden />} onClick={resetFilters}>Сбросить</Button>
              </Space>
            </Form>
          </Card>
        </section>
      )}
      </div>
      <Table
        {...tableProps}
        {...highlightProps}
        rowKey="film_id"
        tableLayout="fixed"
        scroll={{ x: '100%' }}
        sticky={{ offsetHeader: tabsHeight + headHeight }}
        onRow={(record) => ({
          onDoubleClick: () => {
            show("films", record.film_id);
          },
        })}
      >
        <Table.Column dataIndex="film_id" title="id" sorter width={WIDTH.id} />
        <Table.Column dataIndex="sort_order" title="Порядок" sorter width={WIDTH.sort} />
        <Table.Column dataIndex="film_name" title="Название" sorter render={(value: string) => <span className="films-list__name">{value}</span>} />
        <Table.Column dataIndex="nomenclature_type" title="Тип номенклатуры" width={WIDTH.nomenclatureType} />
        <Table.Column dataIndex="nomenclature_category" title="Категория" width={WIDTH.category} render={(value: string | null) => <span className="films-list__category">{value}</span>} />
        <Table.Column
          dataIndex="note"
          title="Примечание"
          width={WIDTH.note}
          ellipsis={{ showTitle: true }}
          render={(value: string | null) => (value ? value.replace(/\s*\n\s*/g, ' · ') : '')}
        />
        <Table.Column
          dataIndex="film_type_id"
          title="Тип плёнки"
          width={WIDTH.filmType}
          render={(_, record: any) =>
            typeMap[record?.film_type_id] ?? record?.film_type_id
          }
        />
        <Table.Column
          dataIndex="vendor_id"
          title="Поставщик плёнки"
          width={WIDTH.vendor}
          render={(_, record: any) =>
            vendorMap[record?.vendor_id] ?? record?.vendor_id
          }
        />
        <Table.Column dataIndex="film_texture" title="Фактура" width={WIDTH.texture} render={(value: boolean) => value ? "Да" : "Нет"} />
        <Table.Column
          dataIndex="ref_key_1c"
          title="1C-key"
          width={WIDTH.key}
          render={(value: string | null) => (value ? <Tooltip title={value}><span className="films-list__key">{value}</span></Tooltip> : null)}
        />
        <Table.Column
          dataIndex="is_active"
          title="Активен"
          width={WIDTH.active}
          render={(value: boolean) => (
            <Badge
              status={value ? "success" : "default"}
              text={value ? "Активен" : "Неактивен"}
            />
          )}
        />
        <Table.Column
          width={WIDTH.actions}
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
        <Table.Column title="Каталог" width={WIDTH.catalog} ellipsis render={(_, record: any) => record.canonical_film_id ? <ShowButton resource="films" recordItemId={record.canonical_film_id}>Объединена: {canonicalMap[record.canonical_film_id] ?? `#${record.canonical_film_id}`}</ShowButton> : null} />
      </Table>
      </div>
    </LocalizedList>
  );
};
