import React, { useMemo, useState, useCallback, useEffect } from "react";
import type { Dayjs } from "dayjs";
import {
  IResourceComponentsProps,
  useMany,
  useNavigation,
  useList,
} from "@refinedev/core";
import {
  List,
  useTable,
  ShowButton,
  EditButton,
  CreateButton,
  useSelect,
} from "@refinedev/antd";
import { Space, Table, Button, Input, message, Tooltip, Form, Row, Col, Select, DatePicker, InputNumber, Card, Typography, Checkbox, Modal, Upload, Dropdown } from "antd";
import {
  EyeOutlined,
  EditOutlined,
  PlusOutlined,
  StarFilled,
  SearchOutlined,
  FilterOutlined,
  ClearOutlined,
  CheckCircleOutlined,
  DownloadOutlined,
  UploadOutlined,
  DatabaseOutlined,
} from "@ant-design/icons";
import type { ColumnsType } from "antd/es/table";
import dayjs from "dayjs";

const { RangePicker } = DatePicker;
const { Text } = Typography;

import { formatNumber } from "../../utils/numberFormat";
import { OrderCreateModal } from "./components/OrderCreateModal";
import { authStorage } from "../../utils/auth";
import { getMaterialTextColor } from "../calendar/utils/statusColors";
import { resolveDetailMaterialName } from "../../utils/materialDisplayName";
import { ProductionStagesDisplay, getPassedCodesFromStatusName } from "../../components/ProductionStagesDisplay";
import { useAppSettings, SETTING_KEYS } from "../../hooks/useAppSettings";
import { buildProductionStagesDisplayConfig } from "../../utils/productionWorkflow";
import type { ProductionStatusRef, ProductionWorkflowConfig } from "../../types/productionWorkflow";
import { featureFlags } from "../../config/featureFlags";
import { ordersApi } from "../../api/ordersApi";
import { findOrderByName, countOrdersAfter } from "../../api/reports/ordersSearchReportApi";
import { HasuraReportError } from "../../api/hasuraReportClient";
import { canQueryUsersResource } from "../../utils/resourcePermissions";
import { GroupFilter } from "./components/groups/GroupFilter";
import { AddToCutModal } from "./components/AddToCutModal";
import { useKeepAlive } from "../../components/workspace/KeepAliveContext";
import { useIsMobile } from "../../hooks/useDeviceTier";
import { OrderCardList } from "./mobile/OrderCardList";
import {
  applyOrderDetailColumnSettings,
  OrderDetailColumnSettingsButton,
  useOrderDetailColumnPreferences,
  type OrderDetailColumnDefinition,
} from "./components/tables/OrderDetailColumnSettings";
import "./list.css";

const ORDER_LIST_COLUMN_DEFINITIONS: OrderDetailColumnDefinition[] = [
  { key: 'order_id', label: 'id', lockVisible: true },
  { key: 'order_name', label: 'Заказ', lockVisible: true },
  ...(featureFlags.projects ? [{ key: 'project_code', label: '№ проекта' }] : []),
  { key: 'doweling_order_name', label: 'Прис.' },
  { key: 'groups', label: 'Группа' },
  { key: 'order_date', label: 'Дата заказа' },
  { key: 'client_name', label: 'Клиент' },
  { key: 'milling_type_name', label: 'Фрез-ка' },
  { key: 'material_name', label: 'Материал' },
  { key: 'notes', label: 'Примечание' },
  { key: 'planned_completion_date', label: 'План. дата вып-я' },
  { key: 'order_status_name', label: 'Статус заказа' },
  { key: 'payment_status_name', label: 'Статус оплаты' },
  { key: 'final_amount', label: 'Сумма, итого' },
  { key: 'production_status_name', label: 'Этапы' },
  { key: 'priority', label: 'Приоритет' },
  { key: 'paid_amount', label: 'Сумма оплаты' },
  { key: 'total_amount', label: 'Сумма заказа' },
  { key: 'discount', label: 'Скидка' },
  { key: 'surcharge', label: 'Наценка' },
  { key: 'design_engineer', label: 'Конструктор' },
  { key: 'payment_date', label: 'Дата оплаты' },
  { key: 'issue_date', label: 'Дата выдачи заказа' },
  { key: 'total_area', label: 'Площадь заказа' },
  { key: 'completion_date', label: 'Дата выполнения' },
  { key: 'parts_count', label: 'Кол-во деталей' },
  { key: 'edge_type_name', label: 'Обкат' },
  { key: 'film_name', label: 'Пленка' },
  { key: 'created_by', label: 'Создано' },
  { key: 'actions', label: 'Действия', lockVisible: true },
];

const ORDER_LIST_DEFAULT_ORDER = ORDER_LIST_COLUMN_DEFINITIONS.map((definition) => definition.key);

export const OrderList: React.FC<IResourceComponentsProps> = () => {
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [searchOrderId, setSearchOrderId] = useState<string>("");
  const [highlightedOrderId, setHighlightedOrderId] = useState<number | null>(null);
  const [form] = Form.useForm();
  const [filtersVisible, setFiltersVisible] = useState(false);
  const [showResultCount, setShowResultCount] = useState(false);
  const [showMyOrders, setShowMyOrders] = useState(false);
  const [groupMode, setGroupMode] = useState<'any' | 'all' | 'primary' | 'none'>('any');
  const [snapshotBatchOpen, setSnapshotBatchOpen] = useState(false);
  const [snapshotBatchRange, setSnapshotBatchRange] = useState<[Dayjs, Dayjs] | null>(null);
  const [snapshotBatchExporting, setSnapshotBatchExporting] = useState(false);
  const [snapshotImporting, setSnapshotImporting] = useState(false);

  // Получаем текущего пользователя для фильтра "Мои заказы"
  const currentUser = authStorage.getUser();
  const useBackendOrdersRead = featureFlags.useBackendOrdersRead;
  const useBackendCut = featureFlags.useBackendCut;
  const [selectedCutOrderIds, setSelectedCutOrderIds] = useState<number[]>([]);
  const [addToCutOpen, setAddToCutOpen] = useState(false);
  const canViewUsers = canQueryUsersResource(currentUser);
  // Keep-alive: when this /orders tab is hidden (another tab active) every data
  // hook is disabled so the cached list stops reacting to invalidateQueries.
  const { isActive } = useKeepAlive();
  const { getSetting } = useAppSettings({ enabled: isActive });

  const { tableProps, current, pageSize, setCurrent, sorters, setSorters, filters, setFilters } = useTable({
    syncWithLocation: true,
    sorters: {
      initial: [
        { field: "order_date", order: "desc" },
        { field: "order_name_numeric", order: "desc" },
      ],
    },
    pagination: {
      mode: "server",
      pageSize: 20,
    },
    queryOptions: { enabled: isActive, refetchOnWindowFocus: false },
  });

  const { show } = useNavigation();
  const isMobile = useIsMobile();

  // Синхронизация состояния чекбокса "Мои заказы" с фильтрами из URL при загрузке
  useEffect(() => {
    if (!currentUser?.id) return;

    const createdByFilter = (filters || []).find((f: any) => f.field === "created_by");
    const isMyOrdersFilter = createdByFilter && Number(createdByFilter.value) === Number(currentUser.id);

    setShowMyOrders(!!isMyOrdersFilter);
  }, [filters, currentUser?.id]);

  useEffect(() => {
    const modeFilter = (filters || []).find((f: any) => f.field === "group_mode");
    const mode = modeFilter?.value;
    if (mode === "any" || mode === "all" || mode === "primary" || mode === "none") {
      setGroupMode(mode);
      form.setFieldValue("group_mode", mode);
    }
  }, [filters, form]);

  // Автоскролл к найденной строке после загрузки данных
  useEffect(() => {
    if (highlightedOrderId && tableProps?.dataSource) {
      // Даём время на рендер таблицы
      const timeoutId = setTimeout(() => {
        const row = document.querySelector(`tr[data-row-key="${highlightedOrderId}"]`);
        if (row) {
          row.scrollIntoView({ behavior: "smooth", block: "center" });
        }
      }, 100);
      return () => clearTimeout(timeoutId);
    }
  }, [highlightedOrderId, tableProps?.dataSource]);

  // Обработчик поиска заказа
  const handleSearchOrder = useCallback(async () => {
    if (!searchOrderId || searchOrderId.trim() === "") {
      message.warning("Введите номер заказа для поиска");
      return;
    }

    const orderName = searchOrderId.trim();

    // Сбрасываем сортировку на order_date DESC + order_name_numeric DESC перед поиском
    const isDefaultSort =
      sorters.length >= 2 &&
      sorters[0].field === "order_date" &&
      sorters[0].order === "desc" &&
      sorters[1].field === "order_name_numeric" &&
      sorters[1].order === "desc";

    if (!isDefaultSort) {
      message.info("Сброс сортировки для поиска...");
      setSorters([
        { field: "order_date", order: "desc" },
        { field: "order_name_numeric", order: "desc" },
      ]);
      // Даем время на применение сортировки
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    try {
      if (useBackendOrdersRead) {
        const response = await ordersApi.list({
          page: 1,
          pageSize: 1,
          search: orderName,
          sortBy: "orderDate",
          sortOrder: "desc",
        });
        const foundOrder = response.data[0];

        if (!foundOrder) {
          message.error(`Заказ с "${orderName}" не найден`);
          return;
        }

        setFilters([{ field: "order_name", operator: "contains", value: orderName }], "replace");
        setCurrent(1);
        setHighlightedOrderId(foundOrder.orderId);
        message.success(`Заказ №${foundOrder.orderName} найден`);

        setTimeout(() => {
          setHighlightedOrderId(null);
        }, 3000);
        return;
      }

      // Шаг 1: Находим заказ по order_name (LIKE поиск)
      let foundOrder;
      try {
        foundOrder = await findOrderByName(orderName);
      } catch (e) {
        message.error(e instanceof HasuraReportError && e.code === 'NOT_AUTHENTICATED'
          ? 'Не авторизован. Пожалуйста, войдите в систему.'
          : (e as Error).message || 'Ошибка поиска');
        return;
      }
      if (!foundOrder) {
        message.error(`Заказ с "${orderName}" не найден`);
        return;
      }
      const foundOrderId = foundOrder.order_id;
      const foundOrderNameNumeric = foundOrder.order_name_numeric;
      const foundOrderDate = foundOrder.order_date;

      // Шаг 2: Получаем количество заказов выше найденного
      // Сортировка уже проверена и сброшена в начале функции (строки 63-78)
      // Считаем заказы "выше" найденного (с учетом сортировки order_date DESC, order_name_numeric DESC):
      // 1. Все заказы с order_date > foundOrderDate
      // 2. ПЛЮС заказы с order_date = foundOrderDate И order_name_numeric > foundOrderNameNumeric
      let greaterCount: number;
      try {
        greaterCount = await countOrdersAfter({ orderDate: foundOrderDate, orderNameNumeric: foundOrderNameNumeric });
      } catch (e) {
        message.error((e as Error).message || 'Ошибка подсчета');
        return;
      }

      // Вычисляем номер страницы (поскольку сортировка DESC, большие ID сверху)
      const targetPage = Math.floor(greaterCount / pageSize) + 1;

      // Переключаем на нужную страницу
      if (targetPage !== current) {
        setCurrent(targetPage);
      }

      // Подсвечиваем найденную строку
      setHighlightedOrderId(foundOrderId);
      message.success(`Заказ №${foundOrder.order_name} найден`);

      // Убираем подсветку через 3 секунды
      setTimeout(() => {
        setHighlightedOrderId(null);
      }, 3000);
    } catch (error) {
      console.error("Ошибка поиска заказа:", error);
      message.error("Ошибка при поиске заказа");
    }
  }, [searchOrderId, pageSize, current, setCurrent, sorters, setSorters, setFilters, useBackendOrdersRead]);

  // useSelect для справочников в фильтрах
  const { selectProps: clientSelectProps } = useSelect({
    resource: "clients",
    optionLabel: "client_name",
    optionValue: "client_id",
    queryOptions: { enabled: isActive },
  });

  const { selectProps: userSelectProps } = useSelect({
    resource: "users",
    optionLabel: "username",
    optionValue: "user_id",
    queryOptions: {
      enabled: isActive && canViewUsers,
    },
  });

  const { selectProps: orderStatusSelectProps } = useSelect({
    resource: "order_statuses",
    optionLabel: "order_status_name",
    optionValue: useBackendOrdersRead ? "order_status_id" : "order_status_name",
    queryOptions: { enabled: isActive },
  });

  const { selectProps: paymentStatusSelectProps } = useSelect({
    resource: "payment_statuses",
    optionLabel: "payment_status_name",
    optionValue: useBackendOrdersRead ? "payment_status_id" : "payment_status_name",
    queryOptions: { enabled: isActive },
  });

  const { selectProps: dowelingSelectProps } = useSelect({
    resource: "doweling_orders",
    optionLabel: "doweling_order_name",
    optionValue: "doweling_order_name",
    queryOptions: { enabled: isActive },
  });

  // Применение фильтров
  const handleFilter = (values: any) => {
    const newFilters: any[] = [];
    const hasValue = (val: any) => val !== undefined && val !== null && val !== "";

    if (hasValue(values.order_name)) {
      newFilters.push({ field: "order_name", operator: "contains", value: values.order_name });
    }

    if (values.order_date_range && Array.isArray(values.order_date_range) && values.order_date_range.length === 2) {
      newFilters.push({ field: "order_date", operator: "gte", value: values.order_date_range[0].format("YYYY-MM-DD") });
      newFilters.push({ field: "order_date", operator: "lte", value: values.order_date_range[1].format("YYYY-MM-DD") });
    }

    if (hasValue(values.client_id)) {
      newFilters.push({ field: "client_id", operator: "eq", value: values.client_id });
    }

    // Если выбрано "created_by" в расширенных фильтрах - используем его
    // Иначе сохраняем фильтр "Мои заказы" если он активен
    if (canViewUsers && hasValue(values.created_by)) {
      newFilters.push({ field: "created_by", operator: "eq", value: values.created_by });
      // Сбрасываем чекбокс если выбран другой пользователь
      if (Number(values.created_by) !== Number(currentUser?.id)) {
        setShowMyOrders(false);
      }
    } else if (showMyOrders && currentUser?.id) {
      // Сохраняем быстрый фильтр "Мои заказы"
      newFilters.push({ field: "created_by", operator: "eq", value: Number(currentUser.id) });
    }

    if (hasValue(values.order_status_name)) {
      newFilters.push({
        field: useBackendOrdersRead ? "order_status_id" : "order_status_name",
        operator: "eq",
        value: values.order_status_name,
      });
    }

    if (hasValue(values.payment_status_name)) {
      newFilters.push({
        field: useBackendOrdersRead ? "payment_status_id" : "payment_status_name",
        operator: "eq",
        value: values.payment_status_name,
      });
    }

    if (hasValue(values.final_amount_min)) {
      newFilters.push({ field: "final_amount", operator: "gte", value: values.final_amount_min });
    }

    if (hasValue(values.final_amount_max)) {
      newFilters.push({ field: "final_amount", operator: "lte", value: values.final_amount_max });
    }

    if (hasValue(values.paid_amount_min)) {
      newFilters.push({ field: "paid_amount", operator: "gte", value: values.paid_amount_min });
    }

    if (hasValue(values.paid_amount_max)) {
      newFilters.push({ field: "paid_amount", operator: "lte", value: values.paid_amount_max });
    }

    if (hasValue(values.doweling_order_name)) {
      newFilters.push({ field: "doweling_order_name", operator: "eq", value: values.doweling_order_name });
    }

    if (useBackendOrdersRead && values.group_mode === "none") {
      newFilters.push({ field: "group_mode", operator: "eq", value: "none" });
    } else if (useBackendOrdersRead && Array.isArray(values.group_ids) && values.group_ids.length > 0) {
      newFilters.push({ field: "group_ids", operator: "in", value: values.group_ids });
      newFilters.push({ field: "group_mode", operator: "eq", value: values.group_mode ?? "any" });
    }

    setFilters(newFilters, "replace");
    setCurrent(1); // Сброс на первую страницу при фильтрации
    setShowResultCount(true);
  };

  // Сброс фильтров
  const handleClearFilters = () => {
    form.resetFields();
    setFilters([], "replace");
    setCurrent(1); // Сброс на первую страницу
    setShowResultCount(false);
    setShowMyOrders(false); // Также сбрасываем быстрый фильтр
    setGroupMode("any");
  };

  // Обработчик переключения фильтра "Мои заказы"
  const handleMyOrdersToggle = useCallback((checked: boolean) => {
    setShowMyOrders(checked);
    if (checked && currentUser?.id) {
      // Добавляем фильтр по текущему пользователю
      const newFilters = [
        ...(filters || []).filter((f: any) => f.field !== "created_by"),
        { field: "created_by", operator: "eq", value: Number(currentUser.id) },
      ];
      setFilters(newFilters, "replace");
    } else {
      // Убираем фильтр по created_by, сохраняя остальные
      const newFilters = (filters || []).filter((f: any) => f.field !== "created_by");
      setFilters(newFilters, "replace");
    }
    setCurrent(1); // Сброс на первую страницу
  }, [currentUser?.id, filters, setFilters, setCurrent]);

  const handleSnapshotBatchExport = async () => {
    if (!snapshotBatchRange) {
      message.warning("Выберите период создания заказов");
      return;
    }

    const [from, to] = snapshotBatchRange;
    setSnapshotBatchExporting(true);
    try {
      await ordersApi.downloadSnapshotBatch(from.format("YYYY-MM-DD"), to.format("YYYY-MM-DD"));
      message.success("Пакетная выгрузка JSON snapshot создана");
      setSnapshotBatchOpen(false);
    } catch (error) {
      message.error("Не удалось создать пакетную выгрузку");
      console.error("Ошибка пакетной выгрузки snapshot:", error);
    } finally {
      setSnapshotBatchExporting(false);
    }
  };

  const handleSnapshotImport = async (file: File) => {
    setSnapshotImporting(true);
    try {
      const isZip = file.name.toLowerCase().endsWith(".zip");
      if (isZip) {
        const result = await ordersApi.importSnapshotBatchFile(file);
        if (result.failed > 0) {
          message.warning(`Импортировано: ${result.imported}, ошибок: ${result.failed}`);
        } else {
          message.success(`Импортировано заказов: ${result.imported}`);
        }
      } else {
        const result = await ordersApi.importSnapshotFile(file);
        message.success(`Заказ ${result.orderName}: ${result.status}`);
      }
      setCurrent(1);
    } catch (error) {
      message.error("Не удалось импортировать snapshot");
      console.error("Ошибка импорта snapshot:", error);
    } finally {
      setSnapshotImporting(false);
    }
  };

  const { settings: orderListColumnSettings, saveSettings: saveOrderListColumnSettings } =
    useOrderDetailColumnPreferences('orderList', ORDER_LIST_DEFAULT_ORDER, ORDER_LIST_COLUMN_DEFINITIONS);

  // Количество записей
  const totalRecords = tableProps?.pagination && typeof tableProps.pagination === 'object' ? tableProps.pagination.total || 0 : 0;
  const ordersCompactPagination = useMemo(() => ({
    ...(tableProps?.pagination && typeof tableProps.pagination === 'object' ? tableProps.pagination : {}),
    position: ['topRight', 'bottomRight'],
    size: 'small',
    showTotal: () => (
      <Space size={4}>
        {useBackendCut && (
          <Button
            size="small"
            disabled={selectedCutOrderIds.length === 0}
            onClick={() => setAddToCutOpen(true)}
          >
            Добавить в раскрой ({selectedCutOrderIds.length})
          </Button>
        )}
        <OrderDetailColumnSettingsButton
          tableKey="orderList"
          definitions={ORDER_LIST_COLUMN_DEFINITIONS}
          defaultOrder={ORDER_LIST_DEFAULT_ORDER}
          settings={orderListColumnSettings}
          onChange={saveOrderListColumnSettings}
        />
      </Space>
    ),
  }), [orderListColumnSettings, saveOrderListColumnSettings, tableProps?.pagination, useBackendCut, selectedCutOrderIds]);

  const formatDate = (date: string | null) => {
    if (!date) return "—";
    return dayjs(date).format("DD.MM.YYYY");
  };

  const renderStatus = (value?: string | null) => {
    const displayValue = value || "—";
    return (
      <Tooltip title={displayValue} placement="topLeft">
        <span className="orders-status-value">{displayValue}</span>
      </Tooltip>
    );
  };

  const createdByIds = useMemo(
    () =>
      Array.from(
        new Set(
          ((tableProps?.dataSource as any[]) || [])
            .map((i) => i?.created_by)
            .filter((v) => v !== undefined && v !== null),
        ),
      ),
    [tableProps?.dataSource],
  );

  const { data: usersData } = useMany({
    resource: "users",
    ids: createdByIds,
    queryOptions: { enabled: isActive && canViewUsers && createdByIds.length > 0 },
  });

  const createdByMap = useMemo(() => {
    const map: Record<string | number, string> = {};
    (usersData?.data || []).forEach((u: any) => {
      map[u.user_id] = u.username;
    });
    return map;
  }, [usersData]);

  // Получаем ID заказов на текущей странице
  const orderIds = useMemo(
    () =>
      Array.from(
        new Set(
          ((tableProps?.dataSource as any[]) || [])
            .map((i) => i?.order_id)
            .filter((v) => v !== undefined && v !== null),
        ),
      ),
    [tableProps?.dataSource],
  );

  // Загружаем детали для заказов на текущей странице
  const { data: detailsData } = useList({
    resource: "order_details",
    filters: [
      {
        field: "order_id",
        operator: "in",
        value: orderIds,
      },
    ],
    pagination: {
      pageSize: 10000,
    },
    queryOptions: {
      enabled: isActive && orderIds.length > 0 && !useBackendOrdersRead,
    },
  });

  // SP3: server-resolved per-detail material name = COALESCE(sheet name,
  // material name) from order_details_view. Additive parallel fetch (Hasura mode
  // only); a missing/untracked view just yields an empty map and the legacy
  // materials map below remains the fallback, so legacy display is unchanged.
  const { data: detailNamesData } = useList({
    resource: "order_details_view",
    filters: [{ field: "order_id", operator: "in", value: orderIds }],
    pagination: { pageSize: 10000 },
    meta: { fields: ["detail_id", "material_name"] },
    queryOptions: {
      enabled:
        isActive && orderIds.length > 0 && !useBackendOrdersRead && featureFlags.sheetMaterialsReads,
    },
  });

  // Загружаем справочники
  const { data: materialsData } = useList({
    resource: "materials",
    pagination: { pageSize: 10000 },
    queryOptions: { enabled: isActive, refetchOnWindowFocus: false },
  });

  const { data: millingTypesData } = useList({
    resource: "milling_types",
    pagination: { pageSize: 10000 },
    queryOptions: { enabled: isActive, refetchOnWindowFocus: false },
  });

  const { data: edgeTypesData } = useList({
    resource: "edge_types",
    pagination: { pageSize: 10000 },
    queryOptions: { enabled: isActive, refetchOnWindowFocus: false },
  });

  const { data: filmsData } = useList({
    resource: "films",
    pagination: { pageSize: 10000 },
    queryOptions: { enabled: isActive, refetchOnWindowFocus: false },
  });

  // Загружаем связи с присадками для заказов на текущей странице
  const { data: dowelingLinksData } = useList({
    resource: "order_doweling_links",
    filters: [
      {
        field: "order_id",
        operator: "in",
        value: orderIds,
      },
    ],
    pagination: { pageSize: 10000 },
    queryOptions: {
      enabled: isActive && orderIds.length > 0 && !useBackendOrdersRead,
    },
  });

  // Загружаем события производственных статусов для заказов на текущей странице
  const { data: productionEventsData } = useList({
    resource: "production_status_events",
    filters: [
      {
        field: "order_id",
        operator: "in",
        value: orderIds,
      },
    ],
    pagination: { pageSize: 10000 },
    queryOptions: {
      enabled: isActive && orderIds.length > 0 && !useBackendOrdersRead,
    },
  });

  // Загружаем справочник production_statuses для маппинга ID -> code
  const { data: productionStatusesData } = useList({
    resource: "production_statuses",
    pagination: { pageSize: 100 },
    // IMPORTANT: explicit is_active filter disables dataProvider auto-filter, so we can map inactive statuses too
    filters: [{ field: "is_active", operator: "in", value: [true, false] }],
    queryOptions: { enabled: isActive, refetchOnWindowFocus: false },
  });

  // Загружаем сотрудников для lookup конструктора
  const { data: employeesData } = useList({
    resource: "employees",
    pagination: { pageSize: 1000 },
    queryOptions: { enabled: isActive, refetchOnWindowFocus: false },
  });

  // Map сотрудников для lookup по employee_id
  const employeesMap = useMemo(() => {
    const map: Record<string | number, string> = {};
    (employeesData?.data || []).forEach((e: any) => {
      map[e.employee_id] = e.full_name;
    });
    return map;
  }, [employeesData]);

  // Группируем связи с присадками по order_id
  const dowelingLinksByOrderId = useMemo(() => {
    const map: Record<string | number, any[]> = {};
    (dowelingLinksData?.data || []).forEach((link: any) => {
      if (!map[link.order_id]) {
        map[link.order_id] = [];
      }
      map[link.order_id].push(link);
    });
    return map;
  }, [dowelingLinksData]);

  // Map production_status_id -> production_status_code
  const productionStatusIdToCode = useMemo(() => {
    const map = new Map<number, string>();
    (productionStatusesData?.data || []).forEach((status: any) => {
      map.set(status.production_status_id, status.production_status_code);
    });
    return map;
  }, [productionStatusesData]);

  const statusesForWorkflow: ProductionStatusRef[] = useMemo(() => {
    return (productionStatusesData?.data || []).map((s: any) => ({
      production_status_id: s.production_status_id,
      production_status_code: s.production_status_code,
      production_status_name: s.production_status_name,
      sort_order: s.sort_order,
      color: s.color,
      is_active: !!s.is_active,
    }));
  }, [productionStatusesData]);

  const workflow = getSetting<ProductionWorkflowConfig>(SETTING_KEYS.PRODUCTION_WORKFLOW_DEFAULT);

  const productionWorkflowDisplay = useMemo(() => {
    if (!statusesForWorkflow || statusesForWorkflow.length === 0) return undefined;
    return buildProductionStagesDisplayConfig({
      workflow,
      statuses: statusesForWorkflow,
      workflowKey: SETTING_KEYS.PRODUCTION_WORKFLOW_DEFAULT,
    }).display;
  }, [workflow, statusesForWorkflow]);

  // Группируем события производственных статусов по order_id и получаем коды
  const passedCodesByOrderId = useMemo(() => {
    const map: Record<number, string[]> = {};
    (productionEventsData?.data || []).forEach((event: any) => {
      if (event.order_id) {
        if (!map[event.order_id]) {
          map[event.order_id] = [];
        }
        const code = productionStatusIdToCode.get(event.production_status_id);
        if (code && !map[event.order_id].includes(code)) {
          map[event.order_id].push(code);
        }
      }
    });
    return map;
  }, [productionEventsData, productionStatusIdToCode]);

  // Функция для получения последней (свежей) присадки для заказа
  const getLatestDoweling = (orderId: number, record?: any) => {
    const links = dowelingLinksByOrderId[orderId] || [];
    if (links.length === 0) {
      const dowelingOrderName = record?.doweling_order_name;
      const dowelingOrderId = record?.doweling_order_id;
      const designEngineerId = record?.design_engineer_id;
      if (!dowelingOrderName && !dowelingOrderId && !designEngineerId) return null;
      return {
        order_doweling_link_id: 0,
        doweling_order_id: dowelingOrderId ?? null,
        doweling_order: {
          doweling_order_id: dowelingOrderId ?? null,
          doweling_order_name: dowelingOrderName ?? null,
          design_engineer_id: designEngineerId ?? null,
        },
      };
    }
    // Сортируем по order_doweling_link_id по убыванию (последняя = самая свежая)
    const sorted = [...links].sort((a, b) => b.order_doweling_link_id - a.order_doweling_link_id);
    return sorted[0];
  };

  // Создаем lookup maps
  const materialsMap = useMemo(() => {
    const map: Record<string | number, string> = {};
    (materialsData?.data || []).forEach((m: any) => {
      map[m.material_id] = m.material_name;
    });
    return map;
  }, [materialsData]);

  // SP3: detail_id -> server-resolved COALESCE(sheet, material) name (order_details_view).
  const resolvedNameByDetailId = useMemo(() => {
    const map = new Map<number, string | null>();
    (detailNamesData?.data || []).forEach((row: any) => {
      if (row?.detail_id != null) map.set(row.detail_id, row.material_name ?? null);
    });
    return map;
  }, [detailNamesData]);

  const millingTypesMap = useMemo(() => {
    const map: Record<string | number, string> = {};
    (millingTypesData?.data || []).forEach((m: any) => {
      map[m.milling_type_id] = m.milling_type_name;
    });
    return map;
  }, [millingTypesData]);

  const edgeTypesMap = useMemo(() => {
    const map: Record<string | number, string> = {};
    (edgeTypesData?.data || []).forEach((e: any) => {
      map[e.edge_type_id] = e.edge_type_name;
    });
    return map;
  }, [edgeTypesData]);

  const filmsMap = useMemo(() => {
    const map: Record<string | number, string> = {};
    (filmsData?.data || []).forEach((f: any) => {
      map[f.film_id] = f.film_name;
    });
    return map;
  }, [filmsData]);

  // Группируем детали по order_id
  const detailsByOrderId = useMemo(() => {
    const map: Record<string | number, any[]> = {};
    (detailsData?.data || []).forEach((detail: any) => {
      if (!map[detail.order_id]) {
        map[detail.order_id] = [];
      }
      map[detail.order_id].push(detail);
    });
    return map;
  }, [detailsData]);

  // Функция: возвращает значение если оно одинаковое для всех деталей, иначе null
  const getCommonValue = (orderId: number, fieldName: string, record?: any) => {
    const details = detailsByOrderId[orderId] || [];
    if (details.length === 0) {
      if (fieldName === "milling_type_id") return record?.milling_type_id ?? null;
      return null;
    }

    const values = details
      .map((d) => d[fieldName])
      .filter((v) => v !== null && v !== undefined);

    if (values.length === 0) return null;

    const uniqueValues = Array.from(new Set(values));
    return uniqueValues.length === 1 ? uniqueValues[0] : null;
  };

  // Функция: возвращает уникальные материалы с цветовой кодировкой
  const getMaterialsList = (orderId: number, record?: any) => {
    const details = detailsByOrderId[orderId] || [];
    let materialNames: string[] = [];

    if (details.length > 0) {
      // SP3: per detail prefer the server-resolved COALESCE name; legacy rows fall
      // back to the materials map (unchanged). Dedupe by resolved display name.
      const names = details
        .map((d) => resolveDetailMaterialName(d, resolvedNameByDetailId, materialsMap))
        .filter((v): v is string => Boolean(v));
      materialNames = Array.from(new Set(names));
    } else if (Array.isArray(record?.material_names)) {
      materialNames = record.material_names;
    } else if (record?.material_name) {
      materialNames = String(record.material_name).split(",");
    }

    materialNames = materialNames
      .map((name) => String(name).trim())
      .filter((name) => name && name.toLowerCase() !== "нд" && !["—", "-", "–"].includes(name));

    if (materialNames.length === 0) return null;

    return (
      <>
        {materialNames.map((name, index) => (
          <span key={index}>
            <span style={{ color: getMaterialTextColor(name), fontWeight: 500 }}>
              {name}
            </span>
            {index < materialNames.length - 1 && ", "}
          </span>
        ))}
      </>
    );
  };

  // Функция: возвращает уникальные пленки всех деталей заказа (аналог getMaterialsList)
  const getFilmsList = (orderId: number, record?: any) => {
    const details = detailsByOrderId[orderId] || [];
    let filmNames: string[] = [];

    if (details.length > 0) {
      const names = details
        .map((d) => (d.film_id != null ? filmsMap[d.film_id] : null))
        .filter((v): v is string => Boolean(v));
      filmNames = Array.from(new Set(names));
    } else if (Array.isArray(record?.film_names)) {
      filmNames = record.film_names;
    } else if (record?.film_name) {
      filmNames = String(record.film_name).split(",");
    }

    filmNames = filmNames
      .map((name) => String(name).trim())
      .filter((name) => name && name.toLowerCase() !== "нд" && !["—", "-", "–"].includes(name));

    if (filmNames.length === 0) return null;

    return (
      <>
        {filmNames.map((name, index) => (
          <span key={index}>
            {name}
            {index < filmNames.length - 1 && ", "}
          </span>
        ))}
      </>
    );
  };

  const orderListColumns: ColumnsType<any> = [
    {
      dataIndex: "order_id",
      key: "order_id",
      title: <span style={{ fontSize: '42%' }}>id</span>,
      sorter: true,
      fixed: "left",
      width: 39,
      className: "col-order-id",
      onHeaderCell: () => ({ className: "col-order-id" }),
      render: (value) => <span style={{ fontSize: '75%', whiteSpace: 'nowrap' }}>{value}</span>,
    },
    {
      dataIndex: "order_name",
      key: "order_name",
      title: "Заказ",
      sorter: true,
      fixed: "left",
      width: 80,
      className: "orders-col orders-col--order-name",
      render: (value) => <span style={{ letterSpacing: '0.5px' }}>{value}</span>,
    },
    ...(featureFlags.projects
      ? [{
          dataIndex: "project_code",
          key: "project_code",
          title: "№ проекта",
          sorter: true,
          width: 92,
          className: "orders-col",
          render: (value: string | null) => value || '—',
        }]
      : []),
    {
      dataIndex: "doweling_order_name",
      key: "doweling_order_name",
      title: "Прис.",
      sorter: true,
      width: 80,
      className: "orders-col orders-col--doweling-name",
      render: (_, record) => {
        const latestLink = getLatestDoweling(record.order_id, record);
        const dowelingName = latestLink?.doweling_order?.doweling_order_name;
        return dowelingName ? (
          <span style={{ color: '#DC2626', letterSpacing: '0.8px' }}>{dowelingName}</span>
        ) : null;
      },
    },
    ...(useBackendOrdersRead && featureFlags.useBackendGroups
      ? [{
          dataIndex: "groups",
          key: "groups",
          title: "Группа",
          width: 150,
          className: "orders-col",
          render: (groups: any[]) => {
            const primary = groups?.find((group) => group.isPrimary) ?? groups?.[0];
            return primary ? (
              <span>{primary.code} · {primary.name}</span>
            ) : (
              <span style={{ color: 'var(--app-text-muted)' }}>Группа не указана</span>
            );
          },
        }]
      : []),
    { dataIndex: "order_date", key: "order_date", title: "Дата заказа", sorter: true, width: 90, className: "orders-col orders-col--order-date", render: (value) => formatDate(value) },
    { dataIndex: "client_name", key: "client_name", title: "Клиент", width: 99, className: "orders-col orders-col--client" },
    {
      dataIndex: "milling_type_name",
      key: "milling_type_name",
      title: "Фрез-ка",
      width: 72,
      className: "orders-col",
      render: (_, record) => {
        const millingTypeId = getCommonValue(record.order_id, "milling_type_id", record);
        const value = (millingTypeId ? millingTypesMap[millingTypeId] : null) || record.milling_type_name;
        if (!value) return null;
        return (
          <Tooltip title={value} placement="topLeft">
            <span className="orders-status-value">{value}</span>
          </Tooltip>
        );
      },
    },
    { dataIndex: "material_name", key: "material_name", title: "Материал", width: 95, className: "orders-col orders-col--wrap", render: (_, record) => getMaterialsList(record.order_id, record) },
    { dataIndex: "notes", key: "notes", title: "Примечание", width: 130, className: "orders-col orders-col--wrap" },
    { dataIndex: "planned_completion_date", key: "planned_completion_date", title: "План. дата вып-я", sorter: true, width: 100, className: "orders-col orders-col--planned-date", render: (value) => formatDate(value) },
    { dataIndex: "order_status_name", key: "order_status_name", title: "Статус заказа", width: 100, className: "orders-col status order-status orders-col--wrap", render: (value) => renderStatus(value) },
    {
      dataIndex: "payment_status_name",
      key: "payment_status_name",
      title: "Статус оплаты",
      width: 100,
      className: "orders-col status payment-status orders-col--wrap",
      render: (value) => {
        const displayValue = value || "—";
        let color = undefined;
        if (value === 'Не оплачен') color = '#ff4d4f';
        else if (value === 'Частично оплачен') color = '#d4a574';
        else if (value === 'Оплачен') color = '#52c41a';

        return (
          <Tooltip title={displayValue} placement="topLeft">
            <span className="orders-status-value" style={{ ...(color && { color, fontWeight: 500 }) }}>
              {displayValue}
            </span>
          </Tooltip>
        );
      },
    },
    { dataIndex: "final_amount", key: "final_amount", title: "Сумма, итого", sorter: true, width: 90, className: "orders-col orders-col--amount", render: (value) => formatNumber(value as number, 0) },
    {
      dataIndex: "production_status_name",
      key: "production_status_name",
      title: "Этапы",
      width: 90,
      className: "orders-col status production-status",
      render: (value, record) => {
        const backendCodes = Array.isArray(record.passed_production_status_codes)
          ? record.passed_production_status_codes
          : [];
        const codes = passedCodesByOrderId[record.order_id]
          || (backendCodes.length > 0 ? backendCodes : getPassedCodesFromStatusName(value || ''));
        return (
          <ProductionStagesDisplay
            passedCodes={codes}
            displayOrderCodes={productionWorkflowDisplay?.displayOrderCodes}
            codeToLetter={productionWorkflowDisplay?.codeToLetter}
            codeToName={productionWorkflowDisplay?.codeToName}
            fontSize={9}
            showTooltip={true}
            maxWidth={85}
          />
        );
      },
    },
    { dataIndex: "priority", key: "priority", title: <StarFilled />, sorter: true, width: 60, className: "col-priority", onHeaderCell: () => ({ className: "col-priority" }) },
    { dataIndex: "paid_amount", key: "paid_amount", title: "Сумма оплаты", sorter: true, width: 90, className: "orders-col orders-col--amount", render: (value) => formatNumber(value as number, 0) },
    { dataIndex: "total_amount", key: "total_amount", title: "Сумма заказа", sorter: true, width: 90, className: "orders-col orders-col--amount", render: (value) => formatNumber(value as number, 0) },
    { dataIndex: "discount", key: "discount", title: "Скидка", sorter: true, width: 88, className: "orders-col", render: (value) => formatNumber(value as number, 0) },
    { dataIndex: "surcharge", key: "surcharge", title: "Наценка", sorter: true, width: 93, className: "orders-col", render: (value) => formatNumber(value as number, 0) },
    {
      key: "design_engineer",
      title: "Конструктор",
      width: 100,
      className: "orders-col orders-col--wrap",
      render: (_, record) => {
        const latestLink = getLatestDoweling(record.order_id, record);
        const engineerId = latestLink?.doweling_order?.design_engineer_id;
        return engineerId ? employeesMap[engineerId] : null;
      },
    },
    { dataIndex: "payment_date", key: "payment_date", title: "Дата оплаты", sorter: true, width: 104, className: "orders-col orders-col--payment-date", render: (value) => formatDate(value) },
    { dataIndex: "issue_date", key: "issue_date", title: "Дата выдачи заказа", sorter: true, width: 86, className: "orders-col", render: (value) => <span style={{ fontSize: '80%' }}>{formatDate(value)}</span> },
    { dataIndex: "total_area", key: "total_area", title: "Площадь заказа", sorter: true, width: 86, className: "orders-col", render: (value) => <span style={{ fontSize: '80%' }}>{value ?? ''}</span> },
    { dataIndex: "completion_date", key: "completion_date", title: "Дата выполнения", sorter: true, width: 86, className: "orders-col", render: (value) => <span style={{ fontSize: '80%' }}>{formatDate(value)}</span> },
    { dataIndex: "parts_count", key: "parts_count", title: "Кол-во деталей", sorter: true, width: 80, className: "orders-col" },
    { dataIndex: "edge_type_name", key: "edge_type_name", title: "Обкат", width: 90, className: "orders-col orders-col--wrap", render: (_, record) => {
      const edgeTypeId = getCommonValue(record.order_id, "edge_type_id");
      return edgeTypeId ? edgeTypesMap[edgeTypeId] : null;
    } },
    { dataIndex: "film_name", key: "film_name", title: "Пленка", width: 120, className: "orders-col orders-col--wrap", render: (_, record) => getFilmsList(record.order_id, record) },
    { dataIndex: "created_by", key: "created_by", title: "Создано", width: 86, className: "orders-col", render: (_, record) => (
      <span style={{ fontSize: '80%' }}>
        {createdByMap[record?.created_by] ?? record?.created_by}
      </span>
    ) },
    {
      key: "actions",
      title: "Действия",
      width: 100,
      fixed: "right",
      render: (_, record) => (
        <Space size={4}>
          <ShowButton hideText size="small" icon={<EyeOutlined style={{ fontSize: 12 }} />} recordItemId={record.order_id} meta={{ syncWithLocation: true }} />
          <EditButton hideText size="small" icon={<EditOutlined style={{ fontSize: 12 }} />} recordItemId={record.order_id} meta={{ syncWithLocation: true }} />
        </Space>
      ),
    },
  ];

  const visibleOrderListColumns = applyOrderDetailColumnSettings(orderListColumns, orderListColumnSettings);

  return (
    <>
      <List
        title="Заказы"
        headerButtons={({ createButtonProps }) => (
          <>
            {createButtonProps && (
              <CreateButton {...createButtonProps}>Создать</CreateButton>
            )}
            <Space.Compact style={{ marginRight: 8 }}>
              <Input
                placeholder="Поиск: номер, ФК26 или ФК26-1258"
                value={searchOrderId}
                onChange={(e) => setSearchOrderId(e.target.value)}
                onPressEnter={handleSearchOrder}
                style={{ width: 200 }}
                allowClear
              />
              <Button
                type="default"
                icon={<SearchOutlined />}
                onClick={handleSearchOrder}
              >
                Найти
              </Button>
            </Space.Compact>
            {/* Быстрый фильтр "Мои заказы" */}
            <Checkbox
              checked={showMyOrders}
              onChange={(e) => handleMyOrdersToggle(e.target.checked)}
              style={{ marginRight: 8 }}
            >
              Мои заказы
            </Checkbox>
            <Button
              type={filtersVisible ? "primary" : "default"}
              icon={<FilterOutlined />}
              onClick={() => setFiltersVisible(!filtersVisible)}
            >
              {filtersVisible ? "Скрыть фильтры" : "Фильтры"}
            </Button>
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => setCreateModalOpen(true)}
            >
              Создать заказ
            </Button>
            <Dropdown
              trigger={["click"]}
              menu={{
                items: [
                  {
                    key: "export",
                    label: (
                      <span>
                        <DownloadOutlined /> Выгрузка JSON
                      </span>
                    ),
                    onClick: () => setSnapshotBatchOpen(true),
                  },
                  {
                    key: "import",
                    label: (
                      <Upload
                        accept=".erp-order.json,.json,.erp-order-batch.zip,.zip,application/json,application/zip"
                        showUploadList={false}
                        beforeUpload={(file) => {
                          void handleSnapshotImport(file);
                          return false;
                        }}
                      >
                        <span>
                          <UploadOutlined /> Загрузка JSON
                        </span>
                      </Upload>
                    ),
                  },
                ],
              }}
            >
              <Button
                icon={<DatabaseOutlined />}
                title="JSON: выгрузка / загрузка"
                loading={snapshotImporting}
              />
            </Dropdown>
          </>
        )}
      >
        <Modal
          title="Пакетная выгрузка JSON snapshot"
          open={snapshotBatchOpen}
          onOk={handleSnapshotBatchExport}
          confirmLoading={snapshotBatchExporting}
          onCancel={() => setSnapshotBatchOpen(false)}
          okText="Выгрузить"
          cancelText="Отмена"
        >
          <Form layout="vertical">
            <Form.Item label="Период создания заказов">
              <RangePicker
                style={{ width: "100%" }}
                format="DD.MM.YYYY"
                value={snapshotBatchRange}
                onChange={(value) => setSnapshotBatchRange(value as [Dayjs, Dayjs] | null)}
              />
            </Form.Item>
          </Form>
        </Modal>
        {filtersVisible && (
          <Card style={{ marginBottom: 16 }}>
            <Form form={form} layout="vertical" onFinish={handleFilter}>
              <Row gutter={16}>
                <Col xs={24} sm={12} md={6} lg={4}>
                  <Form.Item name="order_name" label="Заказ">
                    <Input allowClear placeholder="Номер заказа" />
                  </Form.Item>
                </Col>
                <Col xs={24} sm={12} md={8} lg={5}>
                  <Form.Item name="order_date_range" label="Дата заказа">
                    <RangePicker style={{ width: "100%" }} format="DD.MM.YYYY" />
                  </Form.Item>
                </Col>
                <Col xs={24} sm={12} md={6} lg={4}>
                  <Form.Item name="client_id" label="Клиент">
                    <Select
                      {...clientSelectProps}
                      allowClear
                      placeholder="Выберите"
                      showSearch
                      filterOption={(input, option) =>
                        (option?.label ?? "").toString().toLowerCase().includes(input.toLowerCase())
                      }
                    />
                  </Form.Item>
                </Col>
                {canViewUsers && (
                  <Col xs={24} sm={12} md={6} lg={3}>
                    <Form.Item name="created_by" label="Создано">
                      <Select
                        {...userSelectProps}
                        allowClear
                        placeholder="Пользователь"
                        showSearch
                        filterOption={(input, option) =>
                          (option?.label ?? "").toString().toLowerCase().includes(input.toLowerCase())
                        }
                      />
                    </Form.Item>
                  </Col>
                )}
                <Col xs={24} sm={12} md={6} lg={4}>
                  <Form.Item name="order_status_name" label="Статус заказа">
                    <Select {...orderStatusSelectProps} allowClear placeholder="Статус" />
                  </Form.Item>
                </Col>
                <Col xs={24} sm={12} md={6} lg={4}>
                  <Form.Item name="payment_status_name" label="Статус оплаты">
                    <Select {...paymentStatusSelectProps} allowClear placeholder="Статус" />
                  </Form.Item>
                </Col>
              </Row>
              <Row gutter={16}>
                <Col xs={12} sm={6} md={4} lg={3}>
                  <Form.Item name="final_amount_min" label="Сумма от">
                    <InputNumber
                      style={{ width: "100%" }}
                      placeholder="Мин"
                      min={0}
                      precision={0}
                      formatter={(value) => `${value}`.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}
                      parser={(value) => value?.replace(/\s/g, '') as unknown as number}
                    />
                  </Form.Item>
                </Col>
                <Col xs={12} sm={6} md={4} lg={3}>
                  <Form.Item name="final_amount_max" label="Сумма до">
                    <InputNumber
                      style={{ width: "100%" }}
                      placeholder="Макс"
                      min={0}
                      precision={0}
                      formatter={(value) => `${value}`.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}
                      parser={(value) => value?.replace(/\s/g, '') as unknown as number}
                    />
                  </Form.Item>
                </Col>
                <Col xs={12} sm={6} md={4} lg={3}>
                  <Form.Item name="paid_amount_min" label="Оплата от">
                    <InputNumber
                      style={{ width: "100%" }}
                      placeholder="Мин"
                      min={0}
                      precision={0}
                      formatter={(value) => `${value}`.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}
                      parser={(value) => value?.replace(/\s/g, '') as unknown as number}
                    />
                  </Form.Item>
                </Col>
                <Col xs={12} sm={6} md={4} lg={3}>
                  <Form.Item name="paid_amount_max" label="Оплата до">
                    <InputNumber
                      style={{ width: "100%" }}
                      placeholder="Макс"
                      min={0}
                      precision={0}
                      formatter={(value) => `${value}`.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}
                      parser={(value) => value?.replace(/\s/g, '') as unknown as number}
                    />
                  </Form.Item>
                </Col>
                <Col xs={24} sm={12} md={6} lg={4}>
                  <Form.Item name="doweling_order_name" label="Присадка">
                    <Select
                      {...dowelingSelectProps}
                      allowClear
                      placeholder="Выберите"
                      showSearch
                      filterOption={(input, option) =>
                        (option?.label ?? "").toString().toLowerCase().includes(input.toLowerCase())
                      }
                    />
                  </Form.Item>
                </Col>
                {useBackendOrdersRead && featureFlags.useBackendGroups && (
                  <Col xs={24} sm={12} md={8} lg={5}>
                    <Form.Item name="group_ids" label="Группа">
                      <GroupFilter
                        groupMode={groupMode}
                        onGroupModeChange={(mode) => {
                          setGroupMode(mode);
                          form.setFieldValue("group_mode", mode);
                        }}
                      />
                    </Form.Item>
                    <Form.Item name="group_mode" hidden initialValue="any" />
                  </Col>
                )}
                <Col xs={24} sm={24} md={24} lg={8} style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'flex-end' }}>
                  <Form.Item label=" " colon={false}>
                    <Space size="middle">
                      <Button type="primary" htmlType="submit" icon={<FilterOutlined />}>
                        Применить
                      </Button>
                      <Button onClick={handleClearFilters} icon={<ClearOutlined />}>
                        Сбросить
                      </Button>
                      {showResultCount && (
                        <Text strong style={{ color: '#52c41a', fontSize: '14px' }}>
                          <CheckCircleOutlined /> Найдено: {totalRecords}
                        </Text>
                      )}
                    </Space>
                  </Form.Item>
                </Col>
              </Row>
            </Form>
          </Card>
        )}
        {isMobile ? (
          <OrderCardList
            rows={tableProps.dataSource ?? []}
            loading={!!tableProps.loading}
            pagination={tableProps.pagination ?? false}
            onOpen={(id) => show("orders_view", id, "push")}
          />
        ) : (
          <Table
            {...tableProps}
            rowKey="order_id"
            sticky
            rowSelection={
              useBackendCut
                ? {
                    selectedRowKeys: selectedCutOrderIds,
                    onChange: (keys) => setSelectedCutOrderIds(keys.map(Number)),
                    preserveSelectedRowKeys: true,
                  }
                : undefined
            }
            className="orders-table"
            pagination={ordersCompactPagination}
            scroll={{ x: "max-content", y: 600 }}
            showSorterTooltip={{ mouseEnterDelay: 1 }}
            rowClassName={(record) =>
              record.order_id === highlightedOrderId ? "highlighted-row" : ""
            }
            onRow={(record) => ({
              onDoubleClick: () => {
                show("orders_view", record.order_id, "push");
              },
            })}
            columns={visibleOrderListColumns}
          />
        )}
      </List>

      <OrderCreateModal
        open={createModalOpen}
        onClose={() => setCreateModalOpen(false)}
      />

      {useBackendCut && (
        <AddToCutModal
          open={addToCutOpen}
          orderIds={selectedCutOrderIds}
          onClose={() => setAddToCutOpen(false)}
          onDone={() => setSelectedCutOrderIds([])}
        />
      )}
    </>
  );
};
