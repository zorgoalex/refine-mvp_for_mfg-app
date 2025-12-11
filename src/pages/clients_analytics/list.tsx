import React, { useState, useCallback, useEffect } from "react";
import { IResourceComponentsProps, useNavigation } from "@refinedev/core";
import { List, useTable, ShowButton, useSelect } from "@refinedev/antd";
import {
  Space,
  Table,
  Badge,
  Input,
  Button,
  message,
  Tooltip,
  Typography,
  Form,
  Row,
  Col,
  Select,
  DatePicker,
  InputNumber,
  Card,
  Checkbox,
} from "antd";
import {
  SearchOutlined,
  FilterOutlined,
  ClearOutlined,
  CheckCircleOutlined,
} from "@ant-design/icons";
import dayjs from "dayjs";
import { formatNumber } from "../../utils/numberFormat";
import { authStorage } from "../../utils/auth";

const { RangePicker } = DatePicker;
const { Text } = Typography;

export const ClientsAnalyticsList: React.FC<IResourceComponentsProps> = () => {
  const [searchValue, setSearchValue] = useState<string>("");
  const [highlightedClientId, setHighlightedClientId] = useState<number | null>(null);
  const [form] = Form.useForm();
  const [filtersVisible, setFiltersVisible] = useState(false);
  const [showResultCount, setShowResultCount] = useState(false);

  const { tableProps, current, pageSize, setCurrent, sorters, setSorters, filters, setFilters } = useTable({
    syncWithLocation: true,
    sorters: {
      initial: [{ field: "client_id", order: "desc" }],
    },
    pagination: {
      mode: "server",
      pageSize: 20,
    },
  });

  const { show } = useNavigation();

  // useSelect для статусов заказов
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

  // Инициализация формы фильтров из URL при монтировании
  useEffect(() => {
    if (filters && filters.length > 0) {
      const formValues: any = {};
      const dateRangeFields: Record<string, { start?: any; end?: any }> = {};

      filters.forEach((filter: any) => {
        const { field, operator, value } = filter;

        // Обработка диапазонов дат
        if (field === 'first_order_date' || field === 'last_order_date' || field === 'last_payment_date' || field === 'last_order_date_exact') {
          const rangeKey = `${field}_range`;
          if (!dateRangeFields[rangeKey]) dateRangeFields[rangeKey] = {};
          if (operator === 'gte') dateRangeFields[rangeKey].start = dayjs(value);
          if (operator === 'lte') dateRangeFields[rangeKey].end = dayjs(value);
        }
        // Обработка числовых диапазонов (min/max)
        else if (operator === 'gte') {
          formValues[`${field}_min`] = value;
        } else if (operator === 'lte') {
          formValues[`${field}_max`] = value;
        }
        // Обработка строковых и точных фильтров
        else if (operator === 'contains') {
          formValues[field] = value;
        } else if (operator === 'eq') {
          formValues[field] = value;
        }
      });

      // Преобразование дат в RangePicker формат
      Object.entries(dateRangeFields).forEach(([key, range]) => {
        if (range.start && range.end) {
          formValues[key] = [range.start, range.end];
        }
      });

      form.setFieldsValue(formValues);
      setShowResultCount(true);
      setFiltersVisible(true);
    }
  }, []); // Только при монтировании

  // Автоскролл к найденной строке после загрузки данных
  useEffect(() => {
    if (highlightedClientId && tableProps?.dataSource) {
      const timeoutId = setTimeout(() => {
        const row = document.querySelector(`tr[data-row-key="${highlightedClientId}"]`);
        if (row) {
          row.scrollIntoView({ behavior: "smooth", block: "center" });
        }
      }, 100);
      return () => clearTimeout(timeoutId);
    }
  }, [highlightedClientId, tableProps?.dataSource]);

  // Обработчик поиска клиента (быстрый поиск с переходом на страницу)
  const handleSearchClient = useCallback(async () => {
    if (!searchValue || searchValue.trim() === "") {
      message.warning("Введите имя клиента для поиска");
      return;
    }

    const clientName = searchValue.trim();

    // Сбрасываем сортировку на client_id DESC перед поиском
    const isDefaultSort =
      sorters.length >= 1 &&
      sorters[0].field === "client_id" &&
      sorters[0].order === "desc";

    if (!isDefaultSort) {
      message.info("Сброс сортировки для поиска...");
      setSorters([{ field: "client_id", order: "desc" }]);
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    try {
      const token = authStorage.getAccessToken();
      if (!token) {
        message.error("Не авторизован. Пожалуйста, войдите в систему.");
        return;
      }

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
              query FindClient($clientNamePattern: String!) {
                clients_analytics_view(
                  where: { client_name: { _ilike: $clientNamePattern } }
                  order_by: [{ client_id: desc }]
                  limit: 1
                ) {
                  client_id
                  client_name
                }
              }
            `,
            variables: { clientNamePattern: `%${clientName}%` },
          }),
        }
      );

      const data = await response.json();

      if (data.errors && data.errors.length > 0) {
        const errorMessage = data.errors[0]?.message || "Ошибка поиска";
        message.error(errorMessage);
        return;
      }

      const clients = data.data?.clients_analytics_view || [];

      if (clients.length === 0) {
        message.error(`Клиент "${clientName}" не найден`);
        return;
      }

      const foundClient = clients[0];
      const foundClientId = foundClient.client_id;

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
              query GetGreaterCount($clientId: bigint!) {
                clients_analytics_view_aggregate(
                  where: { client_id: { _gt: $clientId } }
                ) {
                  aggregate {
                    count
                  }
                }
              }
            `,
            variables: { clientId: foundClientId },
          }),
        }
      );

      const countData = await countResponse.json();

      if (countData.errors && countData.errors.length > 0) {
        message.error(countData.errors[0]?.message || "Ошибка подсчета");
        return;
      }

      const greaterCount = countData.data?.clients_analytics_view_aggregate?.aggregate?.count || 0;
      const targetPage = Math.floor(greaterCount / pageSize) + 1;

      if (targetPage !== current) {
        setCurrent(targetPage);
      }

      setHighlightedClientId(foundClientId);
      message.success(`Клиент "${foundClient.client_name}" найден`);

      setTimeout(() => {
        setHighlightedClientId(null);
      }, 3000);
    } catch (error) {
      console.error("Ошибка поиска клиента:", error);
      message.error("Ошибка при поиске клиента");
    }
  }, [searchValue, pageSize, current, setCurrent, sorters, setSorters]);

  // Применение фильтров
  const handleFilter = (values: any) => {
    const newFilters: any[] = [];
    const hasValue = (val: any) => val !== undefined && val !== null && val !== "";

    // Строковые фильтры (contains/ilike)
    if (hasValue(values.client_name)) {
      newFilters.push({ field: "client_name", operator: "contains", value: values.client_name });
    }
    if (hasValue(values.all_phones)) {
      newFilters.push({ field: "all_phones", operator: "contains", value: values.all_phones });
    }
    if (hasValue(values.notes)) {
      newFilters.push({ field: "notes", operator: "contains", value: values.notes });
    }
    if (hasValue(values.last_order_name)) {
      newFilters.push({ field: "last_order_name", operator: "contains", value: values.last_order_name });
    }

    // Статусы (exact match)
    if (hasValue(values.last_order_status_name)) {
      newFilters.push({ field: "last_order_status_name", operator: "eq", value: values.last_order_status_name });
    }
    if (hasValue(values.last_payment_status_name)) {
      newFilters.push({ field: "last_payment_status_name", operator: "eq", value: values.last_payment_status_name });
    }

    // Boolean фильтры (checkbox - только если checked)
    if (values.has_debt === true) {
      newFilters.push({ field: "has_debt", operator: "eq", value: true });
    }

    // Диапазоны дат
    if (values.first_order_date_range && Array.isArray(values.first_order_date_range) && values.first_order_date_range.length === 2) {
      newFilters.push({ field: "first_order_date", operator: "gte", value: values.first_order_date_range[0].format("YYYY-MM-DD") });
      newFilters.push({ field: "first_order_date", operator: "lte", value: values.first_order_date_range[1].format("YYYY-MM-DD") });
    }
    if (values.last_order_date_range && Array.isArray(values.last_order_date_range) && values.last_order_date_range.length === 2) {
      newFilters.push({ field: "last_order_date", operator: "gte", value: values.last_order_date_range[0].format("YYYY-MM-DD") });
      newFilters.push({ field: "last_order_date", operator: "lte", value: values.last_order_date_range[1].format("YYYY-MM-DD") });
    }
    if (values.last_payment_date_range && Array.isArray(values.last_payment_date_range) && values.last_payment_date_range.length === 2) {
      newFilters.push({ field: "last_payment_date", operator: "gte", value: values.last_payment_date_range[0].format("YYYY-MM-DD") });
      newFilters.push({ field: "last_payment_date", operator: "lte", value: values.last_payment_date_range[1].format("YYYY-MM-DD") });
    }
    if (values.last_order_date_exact_range && Array.isArray(values.last_order_date_exact_range) && values.last_order_date_exact_range.length === 2) {
      newFilters.push({ field: "last_order_date_exact", operator: "gte", value: values.last_order_date_exact_range[0].format("YYYY-MM-DD") });
      newFilters.push({ field: "last_order_date_exact", operator: "lte", value: values.last_order_date_exact_range[1].format("YYYY-MM-DD") });
    }

    // Числовые диапазоны - количества
    if (hasValue(values.orders_total_count_min)) {
      newFilters.push({ field: "orders_total_count", operator: "gte", value: values.orders_total_count_min });
    }
    if (hasValue(values.orders_total_count_max)) {
      newFilters.push({ field: "orders_total_count", operator: "lte", value: values.orders_total_count_max });
    }
    if (hasValue(values.orders_in_progress_count_min)) {
      newFilters.push({ field: "orders_in_progress_count", operator: "gte", value: values.orders_in_progress_count_min });
    }
    if (hasValue(values.orders_in_progress_count_max)) {
      newFilters.push({ field: "orders_in_progress_count", operator: "lte", value: values.orders_in_progress_count_max });
    }
    if (hasValue(values.orders_completed_count_min)) {
      newFilters.push({ field: "orders_completed_count", operator: "gte", value: values.orders_completed_count_min });
    }
    if (hasValue(values.orders_completed_count_max)) {
      newFilters.push({ field: "orders_completed_count", operator: "lte", value: values.orders_completed_count_max });
    }

    // Числовые диапазоны - суммы
    if (hasValue(values.total_amount_sum_min)) {
      newFilters.push({ field: "total_amount_sum", operator: "gte", value: values.total_amount_sum_min });
    }
    if (hasValue(values.total_amount_sum_max)) {
      newFilters.push({ field: "total_amount_sum", operator: "lte", value: values.total_amount_sum_max });
    }
    if (hasValue(values.final_amount_sum_min)) {
      newFilters.push({ field: "final_amount_sum", operator: "gte", value: values.final_amount_sum_min });
    }
    if (hasValue(values.final_amount_sum_max)) {
      newFilters.push({ field: "final_amount_sum", operator: "lte", value: values.final_amount_sum_max });
    }
    if (hasValue(values.discount_sum_min)) {
      newFilters.push({ field: "discount_sum", operator: "gte", value: values.discount_sum_min });
    }
    if (hasValue(values.discount_sum_max)) {
      newFilters.push({ field: "discount_sum", operator: "lte", value: values.discount_sum_max });
    }
    if (hasValue(values.surcharge_sum_min)) {
      newFilters.push({ field: "surcharge_sum", operator: "gte", value: values.surcharge_sum_min });
    }
    if (hasValue(values.surcharge_sum_max)) {
      newFilters.push({ field: "surcharge_sum", operator: "lte", value: values.surcharge_sum_max });
    }
    if (hasValue(values.paid_amount_sum_min)) {
      newFilters.push({ field: "paid_amount_sum", operator: "gte", value: values.paid_amount_sum_min });
    }
    if (hasValue(values.paid_amount_sum_max)) {
      newFilters.push({ field: "paid_amount_sum", operator: "lte", value: values.paid_amount_sum_max });
    }
    if (hasValue(values.debt_sum_min)) {
      newFilters.push({ field: "debt_sum", operator: "gte", value: values.debt_sum_min });
    }
    if (hasValue(values.debt_sum_max)) {
      newFilters.push({ field: "debt_sum", operator: "lte", value: values.debt_sum_max });
    }

    // Числовые диапазоны - детали/площадь/платежи
    if (hasValue(values.parts_count_sum_min)) {
      newFilters.push({ field: "parts_count_sum", operator: "gte", value: values.parts_count_sum_min });
    }
    if (hasValue(values.parts_count_sum_max)) {
      newFilters.push({ field: "parts_count_sum", operator: "lte", value: values.parts_count_sum_max });
    }
    if (hasValue(values.total_area_sum_min)) {
      newFilters.push({ field: "total_area_sum", operator: "gte", value: values.total_area_sum_min });
    }
    if (hasValue(values.total_area_sum_max)) {
      newFilters.push({ field: "total_area_sum", operator: "lte", value: values.total_area_sum_max });
    }
    if (hasValue(values.payments_count_min)) {
      newFilters.push({ field: "payments_count", operator: "gte", value: values.payments_count_min });
    }
    if (hasValue(values.payments_count_max)) {
      newFilters.push({ field: "payments_count", operator: "lte", value: values.payments_count_max });
    }
    if (hasValue(values.payments_total_min)) {
      newFilters.push({ field: "payments_total", operator: "gte", value: values.payments_total_min });
    }
    if (hasValue(values.payments_total_max)) {
      newFilters.push({ field: "payments_total", operator: "lte", value: values.payments_total_max });
    }

    // Суммы последнего заказа
    if (hasValue(values.last_order_total_amount_min)) {
      newFilters.push({ field: "last_order_total_amount", operator: "gte", value: values.last_order_total_amount_min });
    }
    if (hasValue(values.last_order_total_amount_max)) {
      newFilters.push({ field: "last_order_total_amount", operator: "lte", value: values.last_order_total_amount_max });
    }
    if (hasValue(values.last_order_final_amount_min)) {
      newFilters.push({ field: "last_order_final_amount", operator: "gte", value: values.last_order_final_amount_min });
    }
    if (hasValue(values.last_order_final_amount_max)) {
      newFilters.push({ field: "last_order_final_amount", operator: "lte", value: values.last_order_final_amount_max });
    }
    if (hasValue(values.last_order_paid_amount_min)) {
      newFilters.push({ field: "last_order_paid_amount", operator: "gte", value: values.last_order_paid_amount_min });
    }
    if (hasValue(values.last_order_paid_amount_max)) {
      newFilters.push({ field: "last_order_paid_amount", operator: "lte", value: values.last_order_paid_amount_max });
    }

    // Дней с последнего заказа
    if (hasValue(values.days_since_last_order_min)) {
      newFilters.push({ field: "days_since_last_order", operator: "gte", value: values.days_since_last_order_min });
    }
    if (hasValue(values.days_since_last_order_max)) {
      newFilters.push({ field: "days_since_last_order", operator: "lte", value: values.days_since_last_order_max });
    }

    setFilters(newFilters, "replace");
    setCurrent(1);
    setShowResultCount(true);
  };

  // Сброс фильтров
  const handleClearFilters = () => {
    form.resetFields();
    setFilters([], "replace");
    setCurrent(1);
    setShowResultCount(false);
  };

  const formatDate = (date: string | null) => {
    if (!date) return "—";
    return dayjs(date).format("DD.MM.YYYY");
  };

  // Количество записей
  const totalRecords = tableProps?.pagination && typeof tableProps.pagination === 'object' ? tableProps.pagination.total || 0 : 0;

  return (
    <List
      title="+Клиенты (аналитика)"
      headerButtons={() => (
        <>
          <Space.Compact style={{ marginRight: 8 }}>
            <Input
              placeholder="Быстрый поиск по имени"
              value={searchValue}
              onChange={(e) => setSearchValue(e.target.value)}
              onPressEnter={handleSearchClient}
              style={{ width: 200 }}
              allowClear
            />
            <Button
              type="default"
              icon={<SearchOutlined />}
              onClick={handleSearchClient}
            >
              Найти
            </Button>
          </Space.Compact>
          <Button
            type={filtersVisible ? "primary" : "default"}
            icon={<FilterOutlined />}
            onClick={() => setFiltersVisible(!filtersVisible)}
          >
            {filtersVisible ? "Скрыть фильтры" : "Фильтры"}
          </Button>
        </>
      )}
    >
      {filtersVisible && (
        <Card style={{ marginBottom: 16, padding: '8px 12px' }}>
          <style>{`
            .filters-compact .ant-form-item { margin-bottom: 8px; }
            .filters-compact .ant-form-item-label { padding-bottom: 2px; }
            .filters-compact .ant-form-item-label > label { font-size: 11px; white-space: nowrap; }
            .filters-compact .ant-checkbox-wrapper { white-space: nowrap; }
            .range-group { display: flex; gap: 4px; }
            .range-group .ant-input-number { width: 55px !important; }
            .range-group-money .ant-input-number { width: 70px !important; }
            .filters-flex { display: flex; flex-wrap: wrap; gap: 16px 24px; align-items: flex-end; }
            .filters-flex > .filter-item { flex-shrink: 0; }
            .filters-flex > .filter-buttons { margin-left: auto; }
          `}</style>
          <Form form={form} layout="vertical" onFinish={handleFilter} className="filters-compact">
            <div className="filters-flex">
              {/* Строковые фильтры */}
              <div className="filter-item">
                <Form.Item name="client_name" label="Имя клиента">
                  <Input allowClear placeholder="Содерж..." size="small" style={{ width: 100 }} />
                </Form.Item>
              </div>
              <div className="filter-item">
                <Form.Item name="all_phones" label="Телефон">
                  <Input allowClear placeholder="Содерж..." size="small" style={{ width: 90 }} />
                </Form.Item>
              </div>
              <div className="filter-item">
                <Form.Item name="notes" label="Примечание">
                  <Input allowClear placeholder="Содерж..." size="small" style={{ width: 90 }} />
                </Form.Item>
              </div>
              <div className="filter-item">
                <Form.Item name="last_order_name" label="Посл. заказ">
                  <Input allowClear placeholder="Содерж..." size="small" style={{ width: 90 }} />
                </Form.Item>
              </div>
              <div className="filter-item">
                <Form.Item name="has_debt" label="Долг" valuePropName="checked">
                  <Checkbox />
                </Form.Item>
              </div>
              <div className="filter-item">
                <Form.Item name="last_order_status_name" label="Статус заказа">
                  <Select {...orderStatusSelectProps} allowClear placeholder="Все" size="small" style={{ width: 120 }} />
                </Form.Item>
              </div>
              <div className="filter-item">
                <Form.Item name="last_payment_status_name" label="Статус оплаты">
                  <Select {...paymentStatusSelectProps} allowClear placeholder="Все" size="small" style={{ width: 120 }} />
                </Form.Item>
              </div>
              {/* Даты */}
              <div className="filter-item">
                <Form.Item name="first_order_date_range" label="Первый заказ">
                  <RangePicker style={{ width: 180 }} format="DD.MM.YY" size="small" />
                </Form.Item>
              </div>
              <div className="filter-item">
                <Form.Item name="last_order_date_range" label="Последний заказ">
                  <RangePicker style={{ width: 180 }} format="DD.MM.YY" size="small" />
                </Form.Item>
              </div>
              <div className="filter-item">
                <Form.Item name="last_payment_date_range" label="Последний платёж">
                  <RangePicker style={{ width: 180 }} format="DD.MM.YY" size="small" />
                </Form.Item>
              </div>
              {/* Числовые диапазоны */}
              <div className="filter-item">
                <Form.Item label="Всего заказов">
                  <div className="range-group">
                    <Form.Item name="orders_total_count_min" noStyle>
                      <InputNumber min={0} placeholder="Мин" size="small" />
                    </Form.Item>
                    <Form.Item name="orders_total_count_max" noStyle>
                      <InputNumber min={0} placeholder="Макс" size="small" />
                    </Form.Item>
                  </div>
                </Form.Item>
              </div>
              <div className="filter-item">
                <Form.Item label="Заказов в работе">
                  <div className="range-group">
                    <Form.Item name="orders_in_progress_count_min" noStyle>
                      <InputNumber min={0} placeholder="Мин" size="small" />
                    </Form.Item>
                    <Form.Item name="orders_in_progress_count_max" noStyle>
                      <InputNumber min={0} placeholder="Макс" size="small" />
                    </Form.Item>
                  </div>
                </Form.Item>
              </div>
              <div className="filter-item">
                <Form.Item label="Заказов завершено">
                  <div className="range-group">
                    <Form.Item name="orders_completed_count_min" noStyle>
                      <InputNumber min={0} placeholder="Мин" size="small" />
                    </Form.Item>
                    <Form.Item name="orders_completed_count_max" noStyle>
                      <InputNumber min={0} placeholder="Макс" size="small" />
                    </Form.Item>
                  </div>
                </Form.Item>
              </div>
              <div className="filter-item">
                <Form.Item label="Дней с посл.заказа">
                  <div className="range-group">
                    <Form.Item name="days_since_last_order_min" noStyle>
                      <InputNumber min={0} placeholder="Мин" size="small" />
                    </Form.Item>
                    <Form.Item name="days_since_last_order_max" noStyle>
                      <InputNumber min={0} placeholder="Макс" size="small" />
                    </Form.Item>
                  </div>
                </Form.Item>
              </div>
              <div className="filter-item">
                <Form.Item label="Сумма заказов">
                  <div className="range-group range-group-money">
                    <Form.Item name="total_amount_sum_min" noStyle>
                      <InputNumber
                        min={0}
                        placeholder="Мин"
                        size="small"
                        formatter={(value) => `${value}`.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}
                        parser={(value) => value?.replace(/\s/g, '') as unknown as number}
                      />
                    </Form.Item>
                    <Form.Item name="total_amount_sum_max" noStyle>
                      <InputNumber
                        min={0}
                        placeholder="Макс"
                        size="small"
                        formatter={(value) => `${value}`.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}
                        parser={(value) => value?.replace(/\s/g, '') as unknown as number}
                      />
                    </Form.Item>
                  </div>
                </Form.Item>
              </div>
              <div className="filter-item">
                <Form.Item label="Фин. сумма заказов">
                  <div className="range-group range-group-money">
                    <Form.Item name="final_amount_sum_min" noStyle>
                      <InputNumber
                        min={0}
                        placeholder="Мин"
                        size="small"
                        formatter={(value) => `${value}`.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}
                        parser={(value) => value?.replace(/\s/g, '') as unknown as number}
                      />
                    </Form.Item>
                    <Form.Item name="final_amount_sum_max" noStyle>
                      <InputNumber
                        min={0}
                        placeholder="Макс"
                        size="small"
                        formatter={(value) => `${value}`.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}
                        parser={(value) => value?.replace(/\s/g, '') as unknown as number}
                      />
                    </Form.Item>
                  </div>
                </Form.Item>
              </div>
              <div className="filter-item">
                <Form.Item label="Оплачено">
                  <div className="range-group range-group-money">
                    <Form.Item name="paid_amount_sum_min" noStyle>
                      <InputNumber
                        min={0}
                        placeholder="Мин"
                        size="small"
                        formatter={(value) => `${value}`.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}
                        parser={(value) => value?.replace(/\s/g, '') as unknown as number}
                      />
                    </Form.Item>
                    <Form.Item name="paid_amount_sum_max" noStyle>
                      <InputNumber
                        min={0}
                        placeholder="Макс"
                        size="small"
                        formatter={(value) => `${value}`.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}
                        parser={(value) => value?.replace(/\s/g, '') as unknown as number}
                      />
                    </Form.Item>
                  </div>
                </Form.Item>
              </div>
              <div className="filter-item">
                <Form.Item label="Долг">
                  <div className="range-group range-group-money">
                    <Form.Item name="debt_sum_min" noStyle>
                      <InputNumber
                        placeholder="Мин"
                        size="small"
                        formatter={(value) => `${value}`.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}
                        parser={(value) => value?.replace(/\s/g, '') as unknown as number}
                      />
                    </Form.Item>
                    <Form.Item name="debt_sum_max" noStyle>
                      <InputNumber
                        placeholder="Макс"
                        size="small"
                        formatter={(value) => `${value}`.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}
                        parser={(value) => value?.replace(/\s/g, '') as unknown as number}
                      />
                    </Form.Item>
                  </div>
                </Form.Item>
              </div>
              <div className="filter-item">
                <Form.Item label="Скидки">
                  <div className="range-group range-group-money">
                    <Form.Item name="discount_sum_min" noStyle>
                      <InputNumber
                        min={0}
                        placeholder="Мин"
                        size="small"
                        formatter={(value) => `${value}`.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}
                        parser={(value) => value?.replace(/\s/g, '') as unknown as number}
                      />
                    </Form.Item>
                    <Form.Item name="discount_sum_max" noStyle>
                      <InputNumber
                        min={0}
                        placeholder="Макс"
                        size="small"
                        formatter={(value) => `${value}`.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}
                        parser={(value) => value?.replace(/\s/g, '') as unknown as number}
                      />
                    </Form.Item>
                  </div>
                </Form.Item>
              </div>
              <div className="filter-item">
                <Form.Item label="Наценки">
                  <div className="range-group range-group-money">
                    <Form.Item name="surcharge_sum_min" noStyle>
                      <InputNumber
                        min={0}
                        placeholder="Мин"
                        size="small"
                        formatter={(value) => `${value}`.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}
                        parser={(value) => value?.replace(/\s/g, '') as unknown as number}
                      />
                    </Form.Item>
                    <Form.Item name="surcharge_sum_max" noStyle>
                      <InputNumber
                        min={0}
                        placeholder="Макс"
                        size="small"
                        formatter={(value) => `${value}`.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}
                        parser={(value) => value?.replace(/\s/g, '') as unknown as number}
                      />
                    </Form.Item>
                  </div>
                </Form.Item>
              </div>
              <div className="filter-item">
                <Form.Item label="Площадь">
                  <div className="range-group">
                    <Form.Item name="total_area_sum_min" noStyle>
                      <InputNumber min={0} step={0.1} placeholder="Мин" size="small" />
                    </Form.Item>
                    <Form.Item name="total_area_sum_max" noStyle>
                      <InputNumber min={0} step={0.1} placeholder="Макс" size="small" />
                    </Form.Item>
                  </div>
                </Form.Item>
              </div>
              <div className="filter-item">
                <Form.Item label="Деталей">
                  <div className="range-group">
                    <Form.Item name="parts_count_sum_min" noStyle>
                      <InputNumber min={0} placeholder="Мин" size="small" />
                    </Form.Item>
                    <Form.Item name="parts_count_sum_max" noStyle>
                      <InputNumber min={0} placeholder="Макс" size="small" />
                    </Form.Item>
                  </div>
                </Form.Item>
              </div>
              <div className="filter-item">
                <Form.Item label="Платежей">
                  <div className="range-group">
                    <Form.Item name="payments_count_min" noStyle>
                      <InputNumber min={0} placeholder="Мин" size="small" />
                    </Form.Item>
                    <Form.Item name="payments_count_max" noStyle>
                      <InputNumber min={0} placeholder="Макс" size="small" />
                    </Form.Item>
                  </div>
                </Form.Item>
              </div>
              {/* Кнопки */}
              <div className="filter-buttons">
                <Form.Item label=" " colon={false}>
                  <Space size="middle">
                    <Button type="primary" htmlType="submit" icon={<FilterOutlined />} size="small">
                      Применить
                    </Button>
                    <Button onClick={handleClearFilters} icon={<ClearOutlined />} size="small">
                      Сбросить
                    </Button>
                    {showResultCount && (
                      <Text strong style={{ color: '#52c41a', fontSize: '12px' }}>
                        <CheckCircleOutlined /> Найдено: {totalRecords}
                      </Text>
                    )}
                  </Space>
                </Form.Item>
              </div>
            </div>
          </Form>
        </Card>
      )}

      <Table
        {...tableProps}
        rowKey="client_id"
        sticky
        scroll={{ x: "max-content", y: 600 }}
        rowClassName={(record) =>
          record.client_id === highlightedClientId ? "highlighted-row" : ""
        }
        onRow={(record) => ({
          onDoubleClick: () => {
            show("clients_analytics_view", record.client_id, "push");
          },
        })}
      >
        <Table.Column
          dataIndex="client_name"
          title="Клиент"
          sorter
          width={180}
        />
        <Table.Column
          dataIndex="primary_phone"
          title="Телефон"
          width={130}
          render={(value) => value || "—"}
        />
        <Table.Column
          dataIndex="is_active"
          title="Активен"
          width={90}
          render={(value: boolean) => (
            <Badge
              status={value ? "success" : "default"}
              text={value ? "Да" : "Нет"}
            />
          )}
        />
        <Table.Column
          dataIndex="orders_total_count"
          title="Заказов"
          sorter
          width={90}
          align="right"
        />
        <Table.Column
          dataIndex="orders_in_progress_count"
          title="В работе"
          sorter
          width={90}
          align="right"
          render={(value) => (
            <span style={{ color: value > 0 ? '#1890ff' : undefined }}>
              {value}
            </span>
          )}
        />
        <Table.Column
          dataIndex="orders_completed_count"
          title="Завершено"
          sorter
          width={100}
          align="right"
          render={(value) => (
            <span style={{ color: value > 0 ? '#52c41a' : undefined }}>
              {value}
            </span>
          )}
        />
        <Table.Column
          dataIndex="total_amount_sum"
          title="Сумма заказов"
          sorter
          width={120}
          align="right"
          render={(value) => formatNumber(value as number, 0)}
        />
        <Table.Column
          dataIndex="final_amount_sum"
          title="Фин. сумма"
          sorter
          width={110}
          align="right"
          render={(value) => formatNumber(value as number, 0)}
        />
        <Table.Column
          dataIndex="paid_amount_sum"
          title="Оплачено"
          sorter
          width={110}
          align="right"
          render={(value) => formatNumber(value as number, 0)}
        />
        <Table.Column
          dataIndex="debt_sum"
          title="Долг"
          sorter
          width={100}
          align="right"
          render={(value) => (
            <span style={{ color: value > 0 ? '#ff4d4f' : '#52c41a', fontWeight: 500 }}>
              {formatNumber(value as number, 0)}
            </span>
          )}
        />
        <Table.Column
          dataIndex="discount_sum"
          title="Скидки"
          sorter
          width={90}
          align="right"
          render={(value) => (
            <span style={{ color: value > 0 ? '#52c41a' : undefined }}>
              {formatNumber(value as number, 0)}
            </span>
          )}
        />
        <Table.Column
          dataIndex="surcharge_sum"
          title="Наценки"
          sorter
          width={90}
          align="right"
          render={(value) => (
            <span style={{ color: value > 0 ? '#1890ff' : undefined }}>
              {formatNumber(value as number, 0)}
            </span>
          )}
        />
        <Table.Column
          dataIndex="has_debt"
          title="Есть долг"
          width={90}
          render={(value: boolean) => (
            <Badge
              status={value ? "error" : "success"}
              text={value ? "Да" : "Нет"}
            />
          )}
        />
        <Table.Column
          dataIndex="last_order_date"
          title="Посл. заказ"
          sorter
          width={110}
          render={(value) => formatDate(value)}
        />
        <Table.Column
          dataIndex="days_since_last_order"
          title="Дней"
          sorter
          width={70}
          align="right"
          render={(value) => (
            <Tooltip title="Дней с последнего заказа">
              <span>{value ?? "—"}</span>
            </Tooltip>
          )}
        />
        <Table.Column
          dataIndex="last_payment_date"
          title="Посл. платёж"
          sorter
          width={110}
          render={(value) => formatDate(value)}
        />
        <Table.Column
          dataIndex="payments_count"
          title="Платежей"
          sorter
          width={90}
          align="right"
        />
        <Table.Column
          dataIndex="total_area_sum"
          title="Площадь, м²"
          sorter
          width={110}
          align="right"
          render={(value) => formatNumber(value as number, 2)}
        />
        <Table.Column
          dataIndex="parts_count_sum"
          title="Деталей"
          sorter
          width={90}
          align="right"
        />
        <Table.Column
          dataIndex="notes"
          title="Примечание"
          width={150}
          ellipsis={{ showTitle: true }}
          render={(value) => value || "—"}
        />
        <Table.Column
          title="Действия"
          width={80}
          fixed="right"
          render={(_, record: any) => (
            <Space size={4}>
              <ShowButton
                hideText
                size="small"
                recordItemId={record.client_id}
              />
            </Space>
          )}
        />
      </Table>
    </List>
  );
};
