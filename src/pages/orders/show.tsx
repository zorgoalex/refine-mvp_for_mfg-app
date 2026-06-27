import { useShow, useList, useUpdate, useOne, IResourceComponentsProps } from "@refinedev/core";
import { Show, BreadcrumbProps, EditButton } from "@refinedev/antd";
import { Button, Table, Breadcrumb, message, Dropdown, Tooltip, Space } from "antd";
import { PrinterOutlined, HomeOutlined, FileExcelOutlined, ReloadOutlined, DownloadOutlined, DownOutlined, UpOutlined, FilePdfOutlined, FileTextOutlined, MoreOutlined } from "@ant-design/icons";
import { useEffect, useMemo, useRef, useState } from "react";
import { useReactToPrint } from "react-to-print";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useTabStore } from "../../stores/tabStore";
import { resolveDetailMaterialName, resolveHeaderMaterialName } from "../../utils/materialDisplayName";
import { downloadOrderExcel } from "../../utils/excel/generateOrderExcel";
import { generateOrderFileName } from "../../utils/excel/fileNameGenerator";
import { handleExcelError } from "../../utils/excel/excelErrorHandler";
import { OrderPrintView } from "./components/print/OrderPrintView";
import { OrderShowHeader } from "./components/sections/OrderShowHeader";
import { OrderDatesBlock } from "./components/sections/OrderDatesBlock";
import { OrderFinanceBlock } from "./components/sections/OrderFinanceBlock";
import { OrderProductionBlock } from "./components/sections/OrderProductionBlock";
import { OrderFilesBlock } from "./components/sections/OrderFilesBlock";
import { OrderMetaBlock } from "./components/sections/OrderMetaBlock";
import { featureFlags } from "../../config/featureFlags";
import { shouldShowOrderLoading } from "./utils/orderShowLoading";
import { getDowelingOrderShowPath } from "./utils/dowelingOrderPaths";
import { resolveOrderExportClientName, toOrderExportClient } from "./utils/orderExportClient";
import { ordersApi } from "../../api/ordersApi";
import { OrderDeadlinePanel } from "./deadlines/OrderDeadlinePanel";
import { ProjectLinksEditor } from "./components/projects/ProjectLinksEditor";
import { AddToCutModal } from "./components/AddToCutModal";
import { can, canAny } from "../../utils/permissions";
import { cutApi } from "../../api/cutApi";
import type { CutDetailLastReadyRef, CutJobRef } from "../../api/types/cutApi.types";
import { buildCutJobByDetailId, cutJobDeepLink } from "./cutColumnHelpers";
import { TableTopScroll } from "../../components/TableTopScroll";
import { OrderLatestLabelsPreview } from "./components/labels/OrderLatestLabelsPreview";

type OrderInfoPanelKey = 'projects' | 'deadlines' | 'finance' | 'additional';

const orderInfoTabs: Array<{ key: OrderInfoPanelKey; label: string; color: string }> = [
  { key: 'projects', label: 'Проекты', color: '#722ed1' },
  { key: 'deadlines', label: 'Дедлайны', color: '#1677ff' },
  { key: 'finance', label: 'Финансы', color: '#faad14' },
  { key: 'additional', label: 'Дополнительная информация', color: '#595959' },
];



export const OrderShow: React.FC<IResourceComponentsProps> = () => {
  const navigate = useNavigate();
  const [activeInfoPanel, setActiveInfoPanel] = useState<OrderInfoPanelKey | null>(null);

  const { queryResult } = useShow({
    meta: {
      idColumnName: "order_id",
      fields: [
        "order_id",
        "order_name",
        "client_id",
        "client_name",
        "order_date",
        "planned_completion_date",
        "completion_date",
        "issue_date",
        "payment_date",
        "total_amount",
        "final_amount",
        "discount",
        "paid_amount",
        "priority",
        "order_status_name",
        "payment_status_name",
        "manager_id",
        "material_name",
        "milling_type_name",
        "edge_type_name",
        "film_name",
        "notes",
        "parts_count",
        "total_area",
        "link_cutting_file",
        "link_cutting_image_file",
        "link_cad_file",
        "link_pdf_file",
        "doweling_order_id",
        "doweling_order_name",
        "ref_key_1c",
        "version",
        "delete_flag",
        "created_at",
        "updated_at",
        "created_by",
        "edited_by",
      ],
    },
  });
  const { data, isLoading } = queryResult;

  const record = data?.data;
  const useBackendOrdersRead = featureFlags.useBackendOrdersRead;
  const backendOrder = useBackendOrdersRead ? record?.__backendOrder : null;
  const labelsEnabled = featureFlags.labels && canAny(['labels.view', 'labels.generate']);

  // Enrich the workspace tab label once the order record is loaded.
  const location = useLocation();
  const setTabTitle = useTabStore((s) => s.setTabTitle);
  useEffect(() => {
    if (record?.order_name) {
      setTabTitle(location.pathname, `Заказ #${record.order_id} · ${record.order_name}`);
    }
  }, [record?.order_id, record?.order_name, location.pathname, setTabTitle]);

  const { data: clientData, isLoading: clientLoading } = useOne({
    resource: "clients",
    id: record?.client_id,
    queryOptions: {
      enabled: !!record?.client_id,
    },
  });

  const resolvedClientName = resolveOrderExportClientName(record, backendOrder, clientData?.data);
  const exportClient = toOrderExportClient(resolvedClientName);
  const isClientResolving = !!record?.client_id && !resolvedClientName && clientLoading;

  // Загрузка деталей заказа
  const { data: detailsData, isLoading: detailsLoading } = useList({
    resource: "order_details",
    filters: [
      {
        field: "order_id",
        operator: "eq",
        value: record?.order_id,
      },
    ],
    pagination: { pageSize: 1000 },
    queryOptions: {
      enabled: !!record?.order_id && !useBackendOrdersRead,
    },
  });

  // SP3: server-resolved per-detail material name = COALESCE(sheet name, material
  // name) from order_details_view. Additive Hasura-mode fetch; an empty/untracked
  // view falls back to the materials map → legacy display unchanged.
  const { data: detailNamesData } = useList({
    resource: "order_details_view",
    filters: [{ field: "order_id", operator: "eq", value: record?.order_id }],
    pagination: { pageSize: 1000 },
    meta: { fields: ["detail_id", "material_name"] },
    queryOptions: {
      enabled: !!record?.order_id && !useBackendOrdersRead && featureFlags.sheetMaterialsReads,
    },
  });
  const resolvedNameByDetailId = useMemo(() => {
    const map = new Map<number, string | null>();
    (detailNamesData?.data || []).forEach((row: any) => {
      if (row?.detail_id != null) map.set(row.detail_id, row.material_name ?? null);
    });
    return map;
  }, [detailNamesData]);

  const details = (
    backendOrder?.details ??
    (detailsData?.data || []).sort((a, b) => (a.detail_number || 0) - (b.detail_number || 0))
  );
  const showLoading = shouldShowOrderLoading({
    orderLoading: isLoading,
    detailsLoading,
    useBackendOrdersRead,
  });

  // Загрузка справочников для отображения названий
  const { data: millingTypesData } = useList({
    resource: "milling_types",
    pagination: { pageSize: 10000 },
  });

  const { data: edgeTypesData } = useList({
    resource: "edge_types",
    pagination: { pageSize: 10000 },
  });

  const { data: filmsData } = useList({
    resource: "films",
    pagination: { pageSize: 10000 },
    filters: [],  // Убираем любые фильтры чтобы загрузить все записи
  });

  const { data: materialsData } = useList({
    resource: "materials",
    pagination: { pageSize: 10000 },
  });

  const { data: paymentTypesData } = useList({
    resource: "payment_types",
    pagination: { pageSize: 1000 },
  });

  // Загрузка телефонов клиента для экспорта
  const { data: clientPhonesData } = useList({
    resource: "client_phones",
    filters: [
      { field: "client_id", operator: "eq", value: record?.client_id },
    ],
    pagination: { pageSize: 100 },
    queryOptions: {
      enabled: !!record?.client_id,
    },
  });

  // Форматирование телефона клиента
  const formatPhone = (phone: string): string => {
    const digits = phone.replace(/\D/g, '');
    if (digits.length === 11) {
      return `8 ${digits.slice(1, 4)} ${digits.slice(4, 7)} ${digits.slice(7, 11)}`;
    } else if (digits.length === 10) {
      return `8 ${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6, 10)}`;
    }
    return phone;
  };

  const clientPhone = (() => {
    const phones = clientPhonesData?.data || [];
    const primary = phones.find((p: any) => p.is_primary) || phones[0];
    return primary?.phone_number ? formatPhone(primary.phone_number) : '';
  })();

  // Создаем lookup maps для быстрого поиска
  const millingTypesMap = new Map(
    (millingTypesData?.data || []).map((item: any) => [item.milling_type_id, item.milling_type_name])
  );
  const edgeTypesMap = new Map(
    (edgeTypesData?.data || []).map((item: any) => [item.edge_type_id, item.edge_type_name])
  );
  const filmsMap = new Map(
    (filmsData?.data || []).map((item: any) => [item.film_id, item.film_name])
  );
  const materialsMap = new Map(
    (materialsData?.data || []).map((item: any) => [item.material_id, item.material_name])
  );
  const paymentTypesMap = new Map(
    (paymentTypesData?.data || []).map((item: any) => [item.type_paid_id, item.type_paid_name])
  );

  // SP3: unique server-resolved display material names for the show header summary.
  const headerMaterialNames = useMemo(() => {
    const names = (details || [])
      .map((d: any) => resolveDetailMaterialName(d, resolvedNameByDetailId, materialsMap))
      .filter((v): v is string => Boolean(v));
    return Array.from(new Set(names));
  }, [details, resolvedNameByDetailId, materialsData]);
  // Header-only/no-details order: the order's own material (orders_view COALESCE
  // in Hasura mode / backend header COALESCE name).
  const headerMaterialName =
    resolveHeaderMaterialName(record) ??
    resolveHeaderMaterialName(backendOrder?.header) ??
    backendOrder?.header?.materialName ??
    null;

  // Ref для печати
  const printRef = useRef<HTMLDivElement>(null);

  // Состояние для экспорта
  const [isExporting, setIsExporting] = useState(false);
  const [isSnapshotExporting, setIsSnapshotExporting] = useState(false);

  // Состояние для выбора деталей в раскрой
  const cutEnabled = featureFlags.useBackendCut && can('cut.manage');
  const [cutSelectMode, setCutSelectMode] = useState(false);
  const [cutSelectedDetailIds, setCutSelectedDetailIds] = useState<number[]>([]);
  const [cutModalOpen, setCutModalOpen] = useState(false);

  useEffect(() => {
    if (!cutSelectMode) setCutSelectedDetailIds([]);
  }, [cutSelectMode]);

  useEffect(() => {
    setCutSelectMode(false);
    setCutSelectedDetailIds([]);
  }, [record?.order_id]);

  // Read-only «Раскрой» column gate (cut.view; distinct from the cut.manage
  // add-to-cut button gate above). Off ⇒ no fetch, no column (legacy behavior).
  const cutColumnEnabled = featureFlags.useBackendCut && can('cut.view');
  const [cutJobByDetailId, setCutJobByDetailId] = useState<Map<number, CutDetailLastReadyRef>>(
    () => new Map(),
  );

  // Stable positive detail ids + a primitive key so the fetch effect does NOT
  // re-run on every rerender just because `details` is a fresh array identity
  // (it is derived inline each render from backendOrder?.details or a sorted
  // query array). Keying on the joined id string makes the fetch fire only when
  // the actual set of detail ids changes.
  const cutDetailIds = useMemo(
    () =>
      details
        .map((d: any) => d?.detail_id)
        .filter((id: unknown): id is number => Number.isInteger(id) && (id as number) > 0),
    [details],
  );
  const cutDetailIdsKey = cutDetailIds.join(',');

  useEffect(() => {
    if (!cutColumnEnabled || cutDetailIds.length === 0) {
      setCutJobByDetailId(new Map());
      return;
    }
    let cancelled = false;
    cutApi
      .listDetailLastReady(cutDetailIds)
      .then((res) => {
        if (!cancelled) setCutJobByDetailId(buildCutJobByDetailId(res.details));
      })
      .catch(() => {
        if (!cancelled) setCutJobByDetailId(new Map());
      });
    return () => {
      cancelled = true;
    };
    // cutDetailIdsKey is the primitive identity of cutDetailIds; intentionally
    // depend on it instead of the array to avoid redundant fetches.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cutColumnEnabled, cutDetailIdsKey]);

  // All distinct active cut jobs that contain details from THIS order (a detail
  // may be placed in several jobs — list them all). Same cut.view gate as the
  // column; powers the «Раскрой» sub-block in the additional-info panel.
  const [cutOrderJobs, setCutOrderJobs] = useState<CutJobRef[]>([]);
  useEffect(() => {
    if (!cutColumnEnabled || !record?.order_id) {
      setCutOrderJobs([]);
      return;
    }
    let cancelled = false;
    cutApi
      .listPlacements({ orderIds: [record.order_id] })
      .then((res) => {
        if (!cancelled) setCutOrderJobs(res.jobs);
      })
      .catch(() => {
        if (!cancelled) setCutOrderJobs([]);
      });
    return () => {
      cancelled = true;
    };
  }, [cutColumnEnabled, record?.order_id]);

  // Hook for updating order
  const { mutate: updateOrder, isLoading: isUpdating } = useUpdate();

  // Загрузка платежей для расчёта статуса оплаты и экспорта
  const { data: paymentsData, refetch: refetchPayments } = useList({
    resource: 'payments',
    filters: [
      {
        field: 'order_id',
        operator: 'eq',
        value: record?.order_id,
      },
    ],
    sorters: [{ field: 'payment_date', order: 'asc' }],
    pagination: { pageSize: 1000 },
    queryOptions: {
      enabled: !!record?.order_id && !useBackendOrdersRead,
    },
  });

  const payments = backendOrder?.payments ?? paymentsData?.data ?? [];

  // Загрузка связей с присадками (many-to-many)
  const { data: dowelingLinksData } = useList({
    resource: 'order_doweling_links',
    filters: [
      { field: 'order_id', operator: 'eq', value: record?.order_id },
    ],
    pagination: { pageSize: 100 },
    queryOptions: {
      enabled: !!record?.order_id && !useBackendOrdersRead,
    },
  });

  const dowelingLinks = backendOrder?.dowelingLinks ?? dowelingLinksData?.data ?? [];

  // Загрузка сотрудников для отображения имени конструктора
  const { data: employeesData } = useList({
    resource: 'employees',
    pagination: { pageSize: 1000 },
  });

  const employeesMap = new Map(
    (employeesData?.data || []).map((item: any) => [item.employee_id, item.full_name])
  );

  // Функция обновления статуса оплаты
  const handleRefreshPaymentStatus = async () => {
    if (!record?.order_id) return;
    if (useBackendOrdersRead) {
      message.info('В backend-режиме статус оплаты обновляется через сохранение заказа');
      return;
    }

    // Refetch payments to get latest data
    const { data: freshPaymentsData } = await refetchPayments();
    const freshPayments = freshPaymentsData?.data || [];
    const freshTotalAmount = freshPayments.reduce((sum: number, p: any) => sum + (p.amount || 0), 0);

    const discountedAmount = record.final_amount || record.total_amount || 0;

    // Calculate what payment status should be
    let newPaymentStatusId: number;
    if (freshTotalAmount === 0) {
      newPaymentStatusId = 1; // Не оплачено
    } else if (freshTotalAmount < discountedAmount) {
      newPaymentStatusId = 2; // Частично оплачено
    } else {
      newPaymentStatusId = 3; // Оплачено
    }

    // Update paid_amount and payment_status_id in database
    updateOrder(
      {
        resource: 'orders',
        id: record.order_id,
        values: {
          paid_amount: freshTotalAmount,
          payment_status_id: newPaymentStatusId,
        },
        meta: {
          idColumnName: 'order_id',
        },
      },
      {
        onSuccess: () => {
          message.success('Статус оплаты обновлён');
          // Refetch order data
          queryResult.refetch();
        },
        onError: (error) => {
          message.error('Ошибка при обновлении статуса оплаты');
          console.error('Update error:', error);
        },
      }
    );
  };

  // Функция печати
  const handlePrint = useReactToPrint({
    contentRef: printRef,
    documentTitle: `Заказ-${record?.order_id}`,
  });

  // Функция экспорта в Excel
  const handleExportExcel = async () => {
    if (!record) return;

    setIsExporting(true);
    try {
      // Формат файла: заказ-Ф<ГГ>-<ID>-<название>-<клиент>.xlsx
      const fileName = generateOrderFileName({
        orderId: record.order_id,
        orderName: record.order_name,
        orderDate: record.order_date,
        clientName: resolvedClientName ?? undefined,
      });

      // Получение данных присадки и конструктора для экспорта
      const firstDoweling = dowelingLinks[0]?.doweling_order;
      const prisadkaName = firstDoweling?.doweling_order_name || '';
      const designEngineerId = firstDoweling?.design_engineer_id;
      const prisadkaDesignerName = designEngineerId ? employeesMap.get(designEngineerId) || '' : '';

      // Подготовка платежей для экспорта (сортировка по дате по возрастанию)
      const sortedPayments = [...payments].sort((a: any, b: any) => {
        const dateA = a.payment_date ? new Date(a.payment_date).getTime() : 0;
        const dateB = b.payment_date ? new Date(b.payment_date).getTime() : 0;
        return dateA - dateB;
      });

      // Генерация и скачивание Excel
      await downloadOrderExcel(
        {
          order: {
            order_id: record.order_id,
            order_name: record.order_name,
            order_date: record.order_date,
            total_amount: record.total_amount,
            final_amount: record.final_amount,
            paid_amount: record.paid_amount,
            client: exportClient,
            // Данные для экспорта присадки и конструктора
            _exportData: {
              prisadkaName,
              prisadkaDesignerName,
            },
          },
          details: details.map(detail => ({
            detail_id: detail.detail_id,
            length: detail.height, // ⚠️ В БД height = длина детали
            width: detail.width,
            quantity: detail.quantity,
            area: detail.area,
            milling_cost_per_sqm: detail.milling_cost_per_sqm,
            detail_cost: detail.detail_cost,
            notes: detail.note,
            milling_type: { milling_type_name: millingTypesMap.get(detail.milling_type_id) || '' },
            edge_type: { edge_type_name: edgeTypesMap.get(detail.edge_type_id) || '' },
            film: { film_name: filmsMap.get(detail.film_id) || '' },
            material: { material_name: resolveDetailMaterialName(detail, resolvedNameByDetailId, materialsMap) || '' },
          })),
          payments: sortedPayments.map((payment: any) => ({
            payment_id: payment.payment_id,
            payment_date: payment.payment_date,
            amount: payment.amount,
            payment_type: { payment_type_name: paymentTypesMap.get(payment.type_paid_id) || '' },
          })),
          client: exportClient,
          clientPhone,
        },
        fileName
      );

      message.success('Excel файл успешно сгенерирован');
    } catch (error) {
      const errorMessage = handleExcelError(error);
      message.error(errorMessage);
      console.error('Ошибка экспорта:', error);
    } finally {
      setIsExporting(false);
    }
  };

  const handleExportSnapshot = async () => {
    if (!record?.order_id) return;

    setIsSnapshotExporting(true);
    try {
      await ordersApi.downloadSnapshot(record.order_id);
      message.success('JSON snapshot заказа выгружен');
    } catch (error) {
      message.error('Не удалось выгрузить JSON snapshot');
      console.error('Ошибка snapshot export:', error);
    } finally {
      setIsSnapshotExporting(false);
    }
  };

  return (
    <Show
      isLoading={showLoading}
      title="Просмотр заказа"
      breadcrumb={
        <Breadcrumb>
          <Breadcrumb.Item>
            <Link to="/">
              <HomeOutlined />
            </Link>
          </Breadcrumb.Item>
          <Breadcrumb.Item>
            <Link to="/orders">Заказы</Link>
          </Breadcrumb.Item>
          <Breadcrumb.Item>Просмотр</Breadcrumb.Item>
        </Breadcrumb>
      }
      headerButtons={() => (
        <>
          <EditButton>Изменить</EditButton>
          <Button
            icon={<ReloadOutlined />}
            onClick={handleRefreshPaymentStatus}
            loading={isUpdating}
          >
            Обновить
          </Button>
          <Button
            type="primary"
            icon={<PrinterOutlined />}
            onClick={handlePrint}
            disabled={!record || details.length === 0}
          >
            Печать
          </Button>
          <Tooltip title="Экспорт в Excel">
            <Button
              aria-label="Экспорт в Excel"
              icon={<FileExcelOutlined />}
              onClick={handleExportExcel}
              loading={isExporting}
              disabled={!record || details.length === 0 || isClientResolving}
            />
          </Tooltip>
          <Dropdown
            trigger={['click']}
            menu={{
              items: [
                {
                  key: 'pdf',
                  icon: <FilePdfOutlined />,
                  label: 'Экспорт в PDF',
                  disabled: !record || details.length === 0,
                },
                {
                  key: 'json',
                  icon: <FileTextOutlined />,
                  label: 'JSON snapshot',
                  disabled: !record || isSnapshotExporting,
                },
              ],
              onClick: ({ key }) => {
                if (key === 'pdf') {
                  handlePrint();
                }
                if (key === 'json') {
                  void handleExportSnapshot();
                }
              },
            }}
          >
            <Tooltip title="Другие экспорты">
              <Button
                aria-label="Другие экспорты"
                icon={isSnapshotExporting ? <DownloadOutlined /> : <MoreOutlined />}
                loading={isSnapshotExporting}
                disabled={!record}
              />
            </Tooltip>
          </Dropdown>
        </>
      )}
    >
      {record && (
        <>
          {/* Компактная шапка заказа (Read-only summary) */}
          <div style={{ marginBottom: 4 }}>
            <OrderShowHeader
              record={record}
              details={details}
              dowelingLinks={dowelingLinks}
              disableLegacyOrderReads={useBackendOrdersRead}
              detailMaterialNames={headerMaterialNames}
              headerMaterialName={headerMaterialName}
            />
          </div>

          <div style={{ marginBottom: 16 }}>
            <div
              role="tablist"
              aria-label="Секции заказа"
              style={{
                display: 'flex',
                flexWrap: 'nowrap',
                width: '100%',
                borderBottom: '1px solid #d9d9d9',
                overflow: 'hidden',
              }}
            >
              {orderInfoTabs.map((tab) => {
                const isActive = activeInfoPanel === tab.key;

                return (
                  <button
                    key={tab.key}
                    type="button"
                    role="tab"
                    aria-selected={isActive}
                    title={tab.label}
                    onClick={() => setActiveInfoPanel(isActive ? null : tab.key)}
                    style={{
                      flex: '1 1 0',
                      minWidth: 0,
                      height: 30,
                      padding: '4px 8px',
                      border: '1px solid #d9d9d9',
                      borderBottom: isActive ? '1px solid #fff' : '1px solid #d9d9d9',
                      borderRadius: '6px 6px 0 0',
                      background: isActive ? '#fff' : '#fafafa',
                      color: isActive ? tab.color : '#595959',
                      fontSize: 12,
                      fontWeight: 600,
                      cursor: 'pointer',
                      marginBottom: -1,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 4,
                    }}
                  >
                    <span
                      style={{
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {tab.label}
                    </span>
                    {isActive ? <UpOutlined style={{ fontSize: 10 }} /> : <DownOutlined style={{ fontSize: 10 }} />}
                  </button>
                );
              })}
            </div>

            {activeInfoPanel && (
              <div
                role="tabpanel"
                style={{
                  border: '1px solid #d9d9d9',
                  borderTop: 'none',
                  padding: activeInfoPanel === 'additional' ? 8 : 12,
                  background: '#fff',
                }}
              >
                {activeInfoPanel === 'projects' && (
                  useBackendOrdersRead && featureFlags.useBackendProjects && record?.order_id ? (
                    <ProjectLinksEditor
                      orderId={record.order_id}
                      version={record.version ?? backendOrder?.version ?? 0}
                      initialProjects={record.projects ?? backendOrder?.projects ?? []}
                    />
                  ) : (
                    <span style={{ color: '#8c8c8c', fontStyle: 'italic' }}>Проекты недоступны</span>
                  )
                )}

                {activeInfoPanel === 'deadlines' && (
                  <OrderDeadlinePanel orderId={record.order_id} embedded />
                )}

                {activeInfoPanel === 'finance' && (
                  <div
                    onDoubleClick={() => {
                      if (record?.order_id) {
                        navigate(`/orders/edit/${record.order_id}?tab=finance`);
                      }
                    }}
                    style={{ cursor: 'pointer' }}
                  >
                    <OrderFinanceBlock record={record} payments={payments} />
                  </div>
                )}

                {activeInfoPanel === 'additional' && (
                  <>
                    {/* Три колонки: Даты | Производство | Присадки + Раскрой */}
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
                        gap: 12,
                        alignItems: 'start',
                      }}
                    >
                      {/* Колонка 1 — Даты */}
                      <div>
                        <div style={{ fontSize: 12, fontWeight: 600, color: '#52c41a', marginBottom: 3 }}>
                          Даты
                        </div>
                        <OrderDatesBlock record={record} compact />
                      </div>

                      {/* Колонка 2 — Производство */}
                      <div style={{ borderLeft: '1px solid #d9d9d9', paddingLeft: 12 }}>
                        <div style={{ fontSize: 12, fontWeight: 600, color: '#fa8c16', marginBottom: 3 }}>
                          Производство
                        </div>
                        <OrderProductionBlock
                          record={record}
                          details={details}
                          millingTypesMap={millingTypesMap}
                          edgeTypesMap={edgeTypesMap}
                          filmsMap={filmsMap}
                          compact
                        />
                      </div>

                      {/* Колонка 3 — Присадки + Раскрой (вертикально, разделены горизонтально) */}
                      <div style={{ borderLeft: '1px solid #d9d9d9', paddingLeft: 12 }}>
                        <div style={{ fontSize: 12, fontWeight: 600, color: '#13c2c2', marginBottom: 3 }}>
                          Присадки
                        </div>
                        {dowelingLinks.length > 0 ? (
                          <Table
                            dataSource={dowelingLinks}
                            rowKey="order_doweling_link_id"
                            size="small"
                            pagination={false}
                            bordered
                            style={{ fontSize: 12 }}
                            components={{
                              header: {
                                cell: (props: any) => <th {...props} style={{ ...props.style, padding: '2px 6px', fontSize: 11 }} />,
                              },
                              body: {
                                cell: (props: any) => <td {...props} style={{ ...props.style, padding: '2px 6px', fontSize: 12 }} />,
                              },
                            }}
                            columns={[
                              {
                                title: 'Номер присадки',
                                key: 'name',
                                render: (_, link: any) => {
                                  const dowelingOrderId =
                                    link.doweling_order?.doweling_order_id ?? link.doweling_order_id;
                                  const dowelingOrderName =
                                    link.doweling_order?.doweling_order_name ||
                                    link.doweling_order_name ||
                                    (dowelingOrderId ? String(dowelingOrderId) : '—');
                                  const showPath = getDowelingOrderShowPath(dowelingOrderId);

                                  return showPath ? (
                                    <Link to={showPath}>{dowelingOrderName}</Link>
                                  ) : (
                                    dowelingOrderName
                                  );
                                },
                              },
                              {
                                title: 'Конструктор',
                                key: 'engineer',
                                render: (_, link: any) => {
                                  const engineerId = link.doweling_order?.design_engineer_id;
                                  return engineerId ? employeesMap.get(engineerId) || '—' : '—';
                                },
                              },
                            ]}
                          />
                        ) : (
                          <span style={{ color: '#8c8c8c', fontStyle: 'italic' }}>Нет связанных присадок</span>
                        )}

                        {/* Раскрой — под присадками, горизонтальный разделитель */}
                        {cutColumnEnabled && (
                          <div style={{ marginTop: 8, borderTop: '1px solid #d9d9d9', paddingTop: 8 }}>
                            <div style={{ fontSize: 12, fontWeight: 600, color: '#1677ff', marginBottom: 3 }}>
                              Раскрой
                            </div>
                            {cutOrderJobs.length === 0 ? (
                              <span style={{ fontSize: 12, color: '#8c8c8c' }}>—</span>
                            ) : (
                              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                                {cutOrderJobs.map((j) => (
                                  <Link
                                    key={j.cutJobId}
                                    to={cutJobDeepLink(j.cutJobId)}
                                    style={{ fontSize: 12 }}
                                  >
                                    {j.name}
                                  </Link>
                                ))}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Ниже — на всю ширину: Файлы, Бирки, Служебная информация */}
                    <div style={{ marginTop: 12, borderTop: '1px solid #d9d9d9', paddingTop: 8 }}>
                      {/* Файлы */}
                      <div style={{ marginBottom: 8 }}>
                        <div style={{ fontSize: 12, fontWeight: 600, color: '#722ed1', marginBottom: 3 }}>
                          Файлы
                        </div>
                        <OrderFilesBlock record={record} compact />
                      </div>

                      {labelsEnabled && record?.order_id && (
                        <OrderLatestLabelsPreview orderId={record.order_id} />
                      )}

                      {/* Служебная информация — спойлер, по умолчанию свёрнут */}
                      <details style={{ borderTop: '1px solid #d9d9d9', paddingTop: 8 }}>
                        <summary
                          style={{
                            fontSize: 12,
                            fontWeight: 600,
                            color: '#8c8c8c',
                            marginBottom: 3,
                            cursor: 'pointer',
                          }}
                        >
                          Служебная информация
                        </summary>
                        <div style={{ marginTop: 3 }}>
                          <OrderMetaBlock record={record} compact />
                        </div>
                      </details>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>

          {/* Детали заказа - компактная таблица */}
          <div style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: '#1890ff' }}>
                Детали заказа
              </div>
              {cutEnabled && details.length > 0 && (
                <Space size="small">
                  <Button size="small" onClick={() => setCutSelectMode((v) => !v)}>
                    {cutSelectMode ? 'Отменить выбор' : 'Выделить детали для раскроя'}
                  </Button>
                  {cutSelectMode && (
                    <>
                      <Button
                        size="small"
                        onClick={() =>
                          setCutSelectedDetailIds(
                            cutSelectedDetailIds.length === details.length
                              ? []
                              : details.map((d: any) => d.detail_id),
                          )
                        }
                      >
                        {cutSelectedDetailIds.length === details.length ? 'Снять все' : 'Выделить все'}
                      </Button>
                      <Button
                        size="small"
                        type="primary"
                        disabled={cutSelectedDetailIds.length === 0}
                        onClick={() => setCutModalOpen(true)}
                      >
                        Добавить выбранные в раскрой ({cutSelectedDetailIds.length})
                      </Button>
                    </>
                  )}
                </Space>
              )}
            </div>
            <TableTopScroll>
            <Table
              dataSource={details}
              rowKey="detail_id"
              scroll={{ x: 'max-content' }}
              rowSelection={
                cutSelectMode
                  ? {
                      selectedRowKeys: cutSelectedDetailIds,
                      onChange: (keys) => setCutSelectedDetailIds(keys.map(Number)),
                    }
                  : undefined
              }
              size="small"
              pagination={false}
              bordered
              tableLayout="fixed"
              style={{ fontSize: 12 }}
              rowClassName={(_, index) => index % 2 === 0 ? 'table-row-light' : 'table-row-dark'}
              onRow={() => ({
                onDoubleClick: () => {
                  if (record?.order_id) {
                    navigate(`/orders/edit/${record.order_id}`);
                  }
                },
                style: { cursor: 'pointer' },
              })}
              components={{
                header: {
                  cell: (props: any) => <th {...props} style={{ ...props.style, padding: '2px 4px', fontSize: '70%', textAlign: 'center' }} />
                },
                body: {
                  cell: (props: any) => <td {...props} style={{ ...props.style, padding: '2px 4px', fontSize: '80%' }} />
                }
              }}
              columns={[
                {
                  title: '№',
                  dataIndex: 'detail_number',
                  key: 'detail_number',
                  width: 43,
                  align: 'center',
                },
                {
                  title: 'Высота',
                  dataIndex: 'height',
                  key: 'height',
                  width: 72,
                  align: 'center',
                },
                {
                  title: 'Ширина',
                  dataIndex: 'width',
                  key: 'width',
                  width: 72,
                  align: 'center',
                },
                {
                  title: 'Кол-во',
                  dataIndex: 'quantity',
                  key: 'quantity',
                  width: 63,
                  align: 'center',
                },
                {
                  title: 'м²',
                  dataIndex: 'area',
                  key: 'area',
                  width: 72,
                  align: 'center',
                  render: (value) => value ? value.toFixed(2) : '0.00',
                },
                {
                  title: 'Фрезеровка',
                  key: 'milling_type',
                  width: 128,
                  render: (_, record) => millingTypesMap.get(record.milling_type_id) || '—',
                },
                {
                  title: 'Обкат',
                  key: 'edge_type',
                  width: 51,
                  render: (_, record) => {
                    const edgeTypeName = edgeTypesMap.get(record.edge_type_id) || '—';
                    return <span style={{ fontSize: '0.86em' }}>{edgeTypeName}</span>;
                  },
                },
                {
                  title: 'Материал',
                  key: 'material',
                  width: 77,
                  render: (_, record) => {
                    const materialName =
                      resolveDetailMaterialName(record, resolvedNameByDetailId, materialsMap) || '—';
                    return <span style={{ fontSize: '0.86em' }}>{materialName}</span>;
                  },
                },
                {
                  title: 'Пр-е',
                  dataIndex: 'note',
                  key: 'note',
                  // Без фиксированной ширины - занимает оставшееся пространство
                  render: (value) => (
                    <span style={{ wordBreak: 'break-word', whiteSpace: 'pre-wrap' }}>
                      {value || ''}
                    </span>
                  ),
                },
                {
                  title: 'Цена за кв.м.',
                  dataIndex: 'milling_cost_per_sqm',
                  key: 'milling_cost_per_sqm',
                  width: 70,
                  align: 'right',
                  render: (value) => (value !== null && value !== undefined) ? value.toLocaleString('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 0 }) : '—',
                },
                {
                  title: 'Сумма',
                  dataIndex: 'detail_cost',
                  key: 'detail_cost',
                  width: 65,
                  align: 'right',
                  render: (value) => (value !== null && value !== undefined) ? value.toLocaleString('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 0 }) : '—',
                },
                {
                  title: 'Пленка',
                  key: 'film',
                  width: 104,
                  render: (_, record) => {
                    if (!record.film_id) return '';
                    const filmName = filmsMap.get(record.film_id);
                    return (
                      <span
                        style={{ fontSize: '0.86em', wordBreak: 'break-word', whiteSpace: 'normal' }}
                      >
                        {filmName || ''}
                      </span>
                    );
                  },
                },
                // «Раскрой» — last column (after «Пленка»), read-only deep-link.
                ...(cutColumnEnabled
                  ? [
                      {
                        title: 'Раскрой',
                        key: 'cut_job',
                        width: 150,
                        render: (_: unknown, record: any) => {
                          const ref = cutJobByDetailId.get(record.detail_id);
                          if (!ref) return '—';
                          return <Link to={cutJobDeepLink(ref.cutJobId)}>{ref.name}</Link>;
                        },
                      },
                    ]
                  : []),
              ]}
              summary={() => {
                const totalCount = details.length;
                const totalQuantity = details.reduce((sum, d) => sum + (d.quantity || 0), 0);
                const totalArea = details.reduce((sum, d) => sum + (d.area || 0), 0);
                const totalCost = details.reduce((sum, d) => sum + (d.detail_cost || 0), 0);

                // Footer cells must line up with the RENDERED columns.
                // rowSelection (cutSelectMode) prepends a checkbox column → `base`.
                // The «Раскрой» column is the LAST column (after «Пленка»), so it
                // only appends a trailing cell and does not shift the others.
                const base = cutSelectMode ? 1 : 0;
                return (
                  <Table.Summary fixed>
                    <Table.Summary.Row style={{ backgroundColor: '#fafafa', fontWeight: 'bold' }}>
                      {/* leading checkbox column (only while selecting for cut) */}
                      {cutSelectMode && <Table.Summary.Cell index={0} />}
                      {/* № - количество позиций */}
                      <Table.Summary.Cell index={base + 0} align="center">
                        <span style={{ color: '#1890ff' }}>{totalCount}</span>
                      </Table.Summary.Cell>
                      {/* Высота */}
                      <Table.Summary.Cell index={base + 1} />
                      {/* Ширина */}
                      <Table.Summary.Cell index={base + 2} />
                      {/* Кол-во */}
                      <Table.Summary.Cell index={base + 3} align="center">
                        <span style={{ color: '#1890ff' }}>{totalQuantity}</span>
                      </Table.Summary.Cell>
                      {/* м² */}
                      <Table.Summary.Cell index={base + 4} align="center">
                        <span style={{ color: '#1890ff' }}>{totalArea.toFixed(2)}</span>
                      </Table.Summary.Cell>
                      {/* Фрезеровка */}
                      <Table.Summary.Cell index={base + 5} />
                      {/* Обкат */}
                      <Table.Summary.Cell index={base + 6} />
                      {/* Материал */}
                      <Table.Summary.Cell index={base + 7} />
                      {/* Пр-е */}
                      <Table.Summary.Cell index={base + 8} />
                      {/* Цена за кв.м. */}
                      <Table.Summary.Cell index={base + 9} />
                      {/* Сумма */}
                      <Table.Summary.Cell index={base + 10} align="right">
                        <span style={{ color: '#52c41a' }}>
                          {totalCost.toLocaleString('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                        </span>
                      </Table.Summary.Cell>
                      {/* Пленка */}
                      <Table.Summary.Cell index={base + 11} />
                      {/* Раскрой — last column (conditional), trailing summary cell */}
                      {cutColumnEnabled && <Table.Summary.Cell index={base + 12} />}
                    </Table.Summary.Row>
                  </Table.Summary>
                );
              }}
            />
            </TableTopScroll>
          </div>

          {/* Скрытый компонент для печати */}
          <OrderPrintView
            ref={printRef}
            order={{
              order_id: record.order_id,
              order_name: record.order_name,
              order_date: record.order_date,
              total_amount: record.total_amount,
              final_amount: record.final_amount,
              paid_amount: record.paid_amount,
              parts_count: record.parts_count,
              total_area: record.total_area,
              notes: record.notes,
            }}
            details={details.map(detail => ({
              ...detail,
              milling_type: { milling_type_name: millingTypesMap.get(detail.milling_type_id) || '' },
              edge_type: { edge_type_name: edgeTypesMap.get(detail.edge_type_id) || '' },
              film: { film_name: filmsMap.get(detail.film_id) || '' },
            }))}
            client={exportClient ?? undefined}
          />
          {cutEnabled && record?.order_id && (
            <AddToCutModal
              open={cutModalOpen}
              orderIds={[record.order_id]}
              detailIds={cutSelectedDetailIds}
              onClose={() => setCutModalOpen(false)}
              onDone={() => {
                setCutModalOpen(false);
                setCutSelectMode(false);
                setCutSelectedDetailIds([]);
              }}
            />
          )}
        </>
      )}
    </Show>
  );
};
