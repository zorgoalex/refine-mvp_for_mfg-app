import React, { useMemo, useState, useCallback, useEffect } from "react";
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
import { Space, Table, Button, Input, message, Tooltip, Form, Row, Col, Select, DatePicker, InputNumber, Card, Typography, Checkbox } from "antd";
import {
  EyeOutlined,
  EditOutlined,
  PlusOutlined,
  StarFilled,
  SearchOutlined,
  FilterOutlined,
  ClearOutlined,
  CheckCircleOutlined,
} from "@ant-design/icons";
import dayjs from "dayjs";

const { RangePicker } = DatePicker;
const { Text } = Typography;

import { formatNumber } from "../../utils/numberFormat";
import { OrderCreateModal } from "./components/OrderCreateModal";
import { authStorage } from "../../utils/auth";
import { getMaterialTextColor } from "../calendar/utils/statusColors";
import { ProductionStagesDisplay, getPassedCodesFromStatusName } from "../../components/ProductionStagesDisplay";
import "./list.css";

export const OrderList: React.FC<IResourceComponentsProps> = () => {
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [searchOrderId, setSearchOrderId] = useState<string>("");
  const [highlightedOrderId, setHighlightedOrderId] = useState<number | null>(null);
  const [form] = Form.useForm();
  const [filtersVisible, setFiltersVisible] = useState(false);
  const [showResultCount, setShowResultCount] = useState(false);
  const [showMyOrders, setShowMyOrders] = useState(false);

  // Получаем текущего пользователя для фильтра "Мои заказы"
  const currentUser = authStorage.getUser();

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
  });

  const { show } = useNavigation();

  // Синхронизация состояния чекбокса "Мои заказы" с фильтрами из URL при загрузке
  useEffect(() => {
    if (!currentUser?.id) return;

    const createdByFilter = (filters || []).find((f: any) => f.field === "created_by");
    const isMyOrdersFilter = createdByFilter && Number(createdByFilter.value) === Number(currentUser.id);

    setShowMyOrders(!!isMyOrdersFilter);
  }, [filters, currentUser?.id]);

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
      // Получаем JWT токен пользователя
      const token = authStorage.getAccessToken();
      if (!token) {
        message.error("Не авторизован. Пожалуйста, войдите в систему.");
        return;
      }

      // Шаг 1: Находим заказ по order_name (LIKE поиск)
      const response = await fetch(
        `${import.meta.env.VITE_HASURA_GRAPHQL_URL}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${token}`,
          },
          body: JSON.stringify({
            query: `
              query FindOrder($orderNamePattern: String!) {
                orders_view(
                  where: { order_name: { _ilike: $orderNamePattern } }
                  order_by: [{ order_date: desc }, { order_name_numeric: desc }]
                  limit: 1
                ) {
                  order_id
                  order_name
                  order_name_numeric
                  order_date
                }
              }
            `,
            variables: { orderNamePattern: `%${orderName}%` },
          }),
        }
      );

      const data = await response.json();

      if (data.errors && data.errors.length > 0) {
        const errorMessage = data.errors[0]?.message || "Ошибка поиска";
        message.error(errorMessage);
        console.error("GraphQL ошибка:", data.errors);
        return;
      }

      const orders = data.data?.orders_view || [];

      if (orders.length === 0) {
        message.error(`Заказ с "${orderName}" не найден`);
        return;
      }

      const foundOrder = orders[0];
      const foundOrderId = foundOrder.order_id;
      const foundOrderNameNumeric = foundOrder.order_name_numeric;
      const foundOrderDate = foundOrder.order_date;

      // Шаг 2: Получаем количество заказов выше найденного
      // Сортировка уже проверена и сброшена в начале функции (строки 63-78)
      // Считаем заказы "выше" найденного (с учетом сортировки order_date DESC, order_name_numeric DESC):
      // 1. Все заказы с order_date > foundOrderDate
      // 2. ПЛЮС заказы с order_date = foundOrderDate И order_name_numeric > foundOrderNameNumeric
      const countResponse = await fetch(
        `${import.meta.env.VITE_HASURA_GRAPHQL_URL}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${token}`,
          },
          body: JSON.stringify({
            query: `
              query GetGreaterCount($orderDate: date!, $orderNameNumeric: Int) {
                orders_view_aggregate(
                  where: {
                    _or: [
                      { order_date: { _gt: $orderDate } }
                      {
                        _and: [
                          { order_date: { _eq: $orderDate } }
                          { order_name_numeric: { _gt: $orderNameNumeric } }
                        ]
                      }
                    ]
                  }
                ) {
                  aggregate {
                    count
                  }
                }
              }
            `,
            variables: {
              orderDate: foundOrderDate,
              orderNameNumeric: foundOrderNameNumeric,
            },
          }),
        }
      );

      const countData = await countResponse.json();

      if (countData.errors && countData.errors.length > 0) {
        const errorMessage = countData.errors[0]?.message || "Ошибка подсчета";
        message.error(errorMessage);
        console.error("GraphQL ошибка при подсчете:", countData.errors);
        return;
      }

      const greaterCount = countData.data?.orders_view_aggregate?.aggregate?.count || 0;

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
  }, [searchOrderId, pageSize, current, setCurrent, sorters, setSorters]);

  // useSelect для справочников в фильтрах
  const { selectProps: clientSelectProps } = useSelect({
    resource: "clients",
    optionLabel: "client_name",
    optionValue: "client_id",
  });

  const { selectProps: userSelectProps } = useSelect({
    resource: "users",
    optionLabel: "username",
    optionValue: "user_id",
  });

  const { selectProps: orderStatusSelectProps } = useSelect({
    resource: "order_statuses",
    optionLabel: "order_status_name",
    optionValue: "order_status_name",
  });

  const { selectProps: paymentStatusSelectProps } = useSelect({
    resource: "payment_statuses",
    optionLabel: "payment_status_name",
    optionValue: "payment_status_name",
  });

  const { selectProps: dowelingSelectProps } = useSelect({
    resource: "doweling_orders",
    optionLabel: "doweling_order_name",
    optionValue: "doweling_order_name",
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
    if (hasValue(values.created_by)) {
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
      newFilters.push({ field: "order_status_name", operator: "eq", value: values.order_status_name });
    }

    if (hasValue(values.payment_status_name)) {
      newFilters.push({ field: "payment_status_name", operator: "eq", value: values.payment_status_name });
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

  // Количество записей
  const totalRecords = tableProps?.pagination && typeof tableProps.pagination === 'object' ? tableProps.pagination.total || 0 : 0;

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
    queryOptions: { enabled: createdByIds.length > 0 },
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
      enabled: orderIds.length > 0,
    },
  });

  // Загружаем справочники
  const { data: materialsData } = useList({
    resource: "materials",
    pagination: { pageSize: 10000 },
  });

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
      enabled: orderIds.length > 0,
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
      enabled: orderIds.length > 0,
    },
  });

  // Загружаем справочник production_statuses для маппинга ID -> code
  const { data: productionStatusesData } = useList({
    resource: "production_statuses",
    pagination: { pageSize: 100 },
    filters: [{ field: "is_active", operator: "eq", value: true }],
  });

  // Загружаем сотрудников для lookup конструктора
  const { data: employeesData } = useList({
    resource: "employees",
    pagination: { pageSize: 1000 },
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
  const getLatestDoweling = (orderId: number) => {
    const links = dowelingLinksByOrderId[orderId] || [];
    if (links.length === 0) return null;
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
  const getCommonValue = (orderId: number, fieldName: string) => {
    const details = detailsByOrderId[orderId] || [];
    if (details.length === 0) return null;

    const values = details
      .map((d) => d[fieldName])
      .filter((v) => v !== null && v !== undefined);

    if (values.length === 0) return null;

    const uniqueValues = Array.from(new Set(values));
    return uniqueValues.length === 1 ? uniqueValues[0] : null;
  };

  // Функция: возвращает уникальные материалы с цветовой кодировкой
  const getMaterialsList = (orderId: number) => {
    const details = detailsByOrderId[orderId] || [];
    if (details.length === 0) return null;

    const materialIds = details
      .map((d) => d.material_id)
      .filter((v) => v !== null && v !== undefined);

    const uniqueMaterialIds = Array.from(new Set(materialIds));
    const materialNames = uniqueMaterialIds
      .map((id) => materialsMap[id])
      .filter((name) => name && name.toLowerCase() !== "нд" && !["—", "-", "–"].includes(name.trim()));

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
                placeholder="Поиск по номеру заказа"
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
          </>
        )}
      >
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
        <Table
          {...tableProps}
          rowKey="order_id"
          sticky
          className="orders-table"
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
        >
          <Table.Column
            dataIndex="order_id"
            title={<span style={{ fontSize: '42%' }}>id</span>}
            sorter
            width={39}
            className="col-order-id"
            onHeaderCell={() => ({ className: "col-order-id" })}
            render={(value) => <span style={{ fontSize: '75%', whiteSpace: 'nowrap' }}>{value}</span>}
          />
          <Table.Column
            dataIndex="order_name"
            title="Заказ"
            sorter
            width={80}
            className="orders-col orders-col--order-name"
            render={(value) => (
              <span style={{ letterSpacing: '0.5px' }}>{value}</span>
            )}
          />
          <Table.Column
            dataIndex="doweling_order_name"
            title="Прис."
            sorter
            width={80}
            className="orders-col orders-col--doweling-name"
            render={(_, record: any) => {
              const latestLink = getLatestDoweling(record.order_id);
              const dowelingName = latestLink?.doweling_order?.doweling_order_name;
              return dowelingName ? (
                <span style={{ color: '#DC2626', letterSpacing: '0.8px' }}>{dowelingName}</span>
              ) : null;
            }}
          />
          <Table.Column
            dataIndex="order_date"
            title="Дата заказа"
            sorter
            width={90}
            className="orders-col orders-col--order-date"
            render={(value) => formatDate(value)}
          />
          <Table.Column
            dataIndex="client_name"
            title="Клиент"
            width={99}
            className="orders-col orders-col--client"
          />
          <Table.Column
            dataIndex="milling_type_name"
            title="Фрез-ка"
            width={72}
            className="orders-col"
            render={(_, record: any) => {
              const millingTypeId = getCommonValue(record.order_id, "milling_type_id");
              const value = millingTypeId ? millingTypesMap[millingTypeId] : null;
              if (!value) return null;
              return (
                <Tooltip title={value} placement="topLeft">
                  <span className="orders-status-value">{value}</span>
                </Tooltip>
              );
            }}
          />
          <Table.Column
            dataIndex="material_name"
            title="Материал"
            width={95}
            className="orders-col orders-col--wrap"
            render={(_, record: any) => getMaterialsList(record.order_id)}
          />
          <Table.Column
            dataIndex="notes"
            title="Примечание"
            width={130}
            className="orders-col orders-col--wrap"
          />
          <Table.Column
            dataIndex="planned_completion_date"
            title="План. дата вып-я"
            sorter
            width={100}
            className="orders-col orders-col--planned-date"
            render={(value) => formatDate(value)}
          />
          <Table.Column
            dataIndex="order_status_name"
            title="Статус заказа"
            width={100}
            className="orders-col status order-status orders-col--wrap"
            render={(value) => renderStatus(value)}
          />
          <Table.Column
            dataIndex="payment_status_name"
            title="Статус оплаты"
            width={100}
            className="orders-col status payment-status orders-col--wrap"
            render={(value) => {
              const displayValue = value || "—";

              // Определяем цвет в зависимости от статуса
              let color = undefined;
              if (value === 'Не оплачен') {
                color = '#ff4d4f'; // красный
              } else if (value === 'Частично оплачен') {
                color = '#d4a574'; // светло-коричневый
              } else if (value === 'Оплачен') {
                color = '#52c41a'; // зеленый
              }

              return (
                <Tooltip title={displayValue} placement="topLeft">
                  <span
                    className="orders-status-value"
                    style={{
                      ...(color && { color, fontWeight: 500 })
                    }}
                  >
                    {displayValue}
                  </span>
                </Tooltip>
              );
            }}
          />
          <Table.Column
            dataIndex="final_amount"
            title="Сумма, итого"
            sorter
            width={90}
            className="orders-col orders-col--amount"
            render={(value) => formatNumber(value as number, 0)}
          />
          <Table.Column
            dataIndex="production_status_name"
            title="Этапы"
            width={90}
            className="orders-col status production-status"
            render={(value, record: any) => {
              // Сначала пробуем получить из events, если нет - fallback на статус
              const codes = passedCodesByOrderId[record.order_id] || getPassedCodesFromStatusName(value || '');
              return (
                <ProductionStagesDisplay
                  passedCodes={codes}
                  fontSize={9}
                  showTooltip={true}
                  maxWidth={85}
                />
              );
            }}
          />
          <Table.Column
            dataIndex="priority"
            title={<StarFilled />}
            sorter
            width={60}
            className="col-priority"
            onHeaderCell={() => ({ className: "col-priority" })}
          />
          <Table.Column
            dataIndex="paid_amount"
            title="Сумма оплаты"
            sorter
            width={90}
            className="orders-col orders-col--amount"
            render={(value) => formatNumber(value as number, 0)}
          />
          <Table.Column
            dataIndex="total_amount"
            title="Сумма заказа"
            sorter
            width={90}
            className="orders-col orders-col--amount"
            render={(value) => formatNumber(value as number, 0)}
          />
          <Table.Column
            dataIndex="discount"
            title="Скидка"
            sorter
            width={88}
            className="orders-col"
            render={(value) => formatNumber(value as number, 0)}
          />
          <Table.Column
            dataIndex="surcharge"
            title="Наценка"
            sorter
            width={93}
            className="orders-col"
            render={(value) => formatNumber(value as number, 0)}
          />
          <Table.Column
            key="design_engineer"
            title="Конструктор"
            width={100}
            className="orders-col orders-col--wrap"
            render={(_, record: any) => {
              const latestLink = getLatestDoweling(record.order_id);
              const engineerId = latestLink?.doweling_order?.design_engineer_id;
              return engineerId ? employeesMap[engineerId] : null;
            }}
          />
          <Table.Column
            dataIndex="payment_date"
            title="Дата оплаты"
            sorter
            width={104}
            className="orders-col orders-col--payment-date"
            render={(value) => formatDate(value)}
          />
          <Table.Column
            dataIndex="issue_date"
            title="Дата выдачи заказа"
            sorter
            width={86}
            className="orders-col"
            render={(value) => <span style={{ fontSize: '80%' }}>{formatDate(value)}</span>}
          />
          <Table.Column
            dataIndex="total_area"
            title="Площадь заказа"
            sorter
            width={86}
            className="orders-col"
            render={(value) => <span style={{ fontSize: '80%' }}>{value ?? ''}</span>}
          />
          <Table.Column
            dataIndex="completion_date"
            title="Дата выполнения"
            sorter
            width={86}
            className="orders-col"
            render={(value) => <span style={{ fontSize: '80%' }}>{formatDate(value)}</span>}
          />
          <Table.Column
            dataIndex="parts_count"
            title="Кол-во деталей"
            sorter
            width={80}
            className="orders-col"
          />
          <Table.Column
            dataIndex="edge_type_name"
            title="Обкат"
            width={90}
            className="orders-col orders-col--wrap"
            render={(_, record: any) => {
              const edgeTypeId = getCommonValue(record.order_id, "edge_type_id");
              return edgeTypeId ? edgeTypesMap[edgeTypeId] : null;
            }}
          />
          <Table.Column
            dataIndex="film_name"
            title="Пленка"
            width={120}
            className="orders-col orders-col--wrap"
            render={(_, record: any) => {
              const filmId = getCommonValue(record.order_id, "film_id");
              return filmId ? filmsMap[filmId] : null;
            }}
          />
          <Table.Column
            dataIndex="created_by"
            title="Создано"
            width={86}
            className="orders-col"
            render={(_, record: any) => (
              <span style={{ fontSize: '80%' }}>
                {createdByMap[record?.created_by] ?? record?.created_by}
              </span>
            )}
          />
          <Table.Column
            title="Действия"
            width={100}
            fixed="right"
            render={(_, record: any) => (
              <Space size={4}>
                <ShowButton
                  hideText
                  size="small"
                  icon={<EyeOutlined style={{ fontSize: 12 }} />}
                  recordItemId={record.order_id}
                  meta={{ syncWithLocation: true }}
                />
                <EditButton
                  hideText
                  size="small"
                  icon={<EditOutlined style={{ fontSize: 12 }} />}
                  recordItemId={record.order_id}
                  meta={{ syncWithLocation: true }}
                />
              </Space>
            )}
          />
        </Table>
      </List>

      <OrderCreateModal
        open={createModalOpen}
        onClose={() => setCreateModalOpen(false)}
      />
    </>
  );
};

