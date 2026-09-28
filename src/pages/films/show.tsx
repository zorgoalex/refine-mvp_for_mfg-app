import { useShow, IResourceComponentsProps, useOne, useGetIdentity } from "@refinedev/core";
import { Show, TextField, DateField, ShowButton } from "@refinedev/antd";
import { Typography, Badge, Row, Col, Divider, List } from "antd";
import { useEffect, useState } from 'react';
import { filmCatalogImportApi } from '../../api/filmCatalogImportApi';
import type { CatalogNameHistoryDto } from '../../api/types/filmCatalogImportApi.types';
import { DISPLAY_DATE_TIME_SECONDS_FORMAT } from "../../utils/dateFormat";
import { useCurrentRecordTabTitle } from "../../utils/recordTitle";
import { ReferenceSortOrderShow } from "../../components/ReferenceSortOrder";

const { Title } = Typography;

export const FilmShow: React.FC<IResourceComponentsProps> = () => {
  const { queryResult } = useShow({
    meta: { idColumnName: "film_id" },
  });
  const { data, isLoading } = queryResult;

  const record = data?.data;
  const { data: identity } = useGetIdentity<{ permissions?: string[] }>();
  const canViewHistory = (identity?.permissions ?? []).includes('references.view');
  const [history, setHistory] = useState<CatalogNameHistoryDto[]>([]);

  useCurrentRecordTabTitle(record);
  const { data: typeOne } = useOne({
    resource: "film_types",
    id: record?.film_type_id,
    queryOptions: { enabled: !!record?.film_type_id },
  });
  const { data: vendorOne } = useOne({
    resource: "vendors",
    id: record?.vendor_id,
    queryOptions: { enabled: !!record?.vendor_id },
  });
  const { data: canonicalOne } = useOne({ resource: 'films', id: record?.canonical_film_id,
    queryOptions: { enabled: !!record?.canonical_film_id } });
  useEffect(() => {
    if (!canViewHistory || !record?.film_id) { setHistory([]); return; }
    let active = true;
    void filmCatalogImportApi.nameHistory(record.film_id).then((result) => { if (active) setHistory(result.items); }).catch(() => { if (active) setHistory([]); });
    return () => { active = false; };
  }, [canViewHistory, record?.film_id]);

  return (
    <Show isLoading={isLoading} title="Просмотр Плёнки">
      <Title level={5}>Основная информация</Title>
      <Row gutter={[16, 16]}>
        <Col span={8}>
          <Title level={5}>ID</Title>
          <TextField value={record?.film_id} />
        </Col>
        <Col span={8}>
          <Title level={5}>Название</Title>
          <TextField value={record?.film_name} />
        </Col>
        <Col span={8}>
          <Title level={5}>Фактура</Title>
          <TextField value={String(record?.film_texture)} />
        </Col>
      </Row>

      <Divider />

      <Row gutter={[16, 16]}>
        <Col span={8}>
          <Title level={5}>Тип плёнки</Title>
          <TextField value={typeOne?.data?.film_type_name} />
        </Col>
        <Col span={8}>
          <Title level={5}>Поставщик плёнки</Title>
          <TextField value={vendorOne?.data?.vendor_name} />
        </Col>
        <Col span={8}><Title level={5}>Тип номенклатуры</Title><TextField value={record?.nomenclature_type} /></Col>
        <Col span={8}><Title level={5}>Категория номенклатуры</Title><TextField value={record?.nomenclature_category} /></Col>
      </Row>

      <Divider />

      {record?.canonical_film_id && <>
        <Title level={5}>Объединена в</Title>
        <ShowButton resource="films" recordItemId={record.canonical_film_id}>{canonicalOne?.data?.film_name ?? `Плёнка ${record.canonical_film_id}`}</ShowButton>
        <Divider />
      </>}

      {canViewHistory && <>
        <Title level={5}>Прежние названия</Title>
        <List size="small" dataSource={history} locale={{ emptyText: 'История названий пуста' }} renderItem={(item) =>
          <List.Item>{item.oldName}{item.oldVendorName ? ` · ${item.oldVendorName}` : ''} → {item.newName}{item.newVendorName ? ` · ${item.newVendorName}` : ''} ({item.changedAt.slice(0, 10)})</List.Item>}
        />
        <Divider />
      </>}

      <Row gutter={[16, 16]}>
        <Col span={8}>
          <Title level={5}>Активен</Title>
          <Badge
            status={record?.is_active ? "success" : "default"}
            text={record?.is_active ? "Активен" : "Неактивен"}
          />
        </Col>
        <Col span={8}>
          <Title level={5}>Ref Key 1C</Title>
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
