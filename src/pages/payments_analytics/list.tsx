import React, { useState, useCallback, useEffect } from "react";
import { IResourceComponentsProps, useNavigation } from "@refinedev/core";
import { List, useTable, ShowButton, useSelect } from "@refinedev/antd";
import {
  Space,
  Table,
  Input,
  Button,
  message,
  Tooltip,
  Typography,
  Form,
  Select,
  DatePicker,
  InputNumber,
  Card,
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

export const PaymentsAnalyticsList: React.FC<IResourceComponentsProps> = () => {
  const [searchValue, setSearchValue] = useState<string>("");
  const [highlightedPaymentId, setHighlightedPaymentId] = useState<number | null>(null);
  const [form] = Form.useForm();
  const [filtersVisible, setFiltersVisible] = useState(false);
  const [showResultCount, setShowResultCount] = useState(false);

  const { tableProps, current, pageSize, setCurrent, sorters, setSorters, filters, setFilters } = useTable({
    syncWithLocation: true,
    sorters: {
      initial: [
        { field: "payment_date", order: "desc" },
        { field: "order_name", order: "desc" },
        { field: "payment_sequence_number", order: "asc" },
      ],
      mode: "server",
    },
    pagination: {
      mode: "server",
      pageSize: 20,
    },
  });

  const { show } = useNavigation();

  // useSelect для статусов
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

  const { selectProps: productionStatusSelectProps } = useSelect({
    resource: "production_statuses",
    optionLabel: "production_status_name",
    optionValue: "production_status_name",
  });

  const { selectProps: paymentTypeSelectProps } = useSelect({
    resource: "payment_types",
    optionLabel: "type_paid_name",
    optionValue: "type_paid_name",
  });

  // Принудительная установка дефолтной сортировки при монтировании
  useEffect(() => {
    // Проверяем что все 3 сортировщика на месте
    const hasCorrectSort =
      sorters.length >= 3 &&
      sorters[0].field === "payment_date" &&
      sorters[1].field === "order_name" &&
      sorters[2].field === "payment_sequence_number";

    if (!hasCorrectSort) {
      setSorters([
        { field: "payment_date", order: "desc" },
        { field: "order_name", order: "desc" },
        { field: "payment_sequence_number", order: "asc" },
      ]);
    }
  }, []); // Только при монтировании

  // Инициализация формы фильтров из URL при монтировании
  useEffect(() => {
    if (filters && filters.length > 0) {
      const formValues: any = {};
      const dateRangeFields: Record<string, { start?: any; end?: any }> = {};

      filters.forEach((filter: any) => {
        const { field, operator, value } = filter;

        // Обработка диапазонов дат
        if (field === 'payment_date' || field === 'order_date') {
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
    if (highlightedPaymentId && tableProps?.dataSource) {
      const timeoutId = setTimeout(() => {
        const row = document.querySelector(`tr[data-row-key="${highlightedPaymentId}"]`);
        if (row) {
          row.scrollIntoView({ behavior: "smooth", block: "center" });
        }
      }, 100);
      return () => clearTimeout(timeoutId);
    }
  }, [highlightedPaymentId, tableProps?.dataSource]);

  // Обработчик поиска по номеру заказа
  const handleSearchOrder = useCallback(async () => {
    if (!searchValue || searchValue.trim() === "") {
      message.warning("Введите номер заказа для поиска");
      return;
    }

    const orderName = searchValue.trim();

    // Сбрасываем сортировку на дефолтную перед поиском
    const isDefaultSort =
      sorters.length >= 3 &&
      sorters[0].field === "payment_date" &&
      sorters[0].order === "desc" &&
      sorters[1].field === "order_name" &&
      sorters[1].order === "desc" &&
      sorters[2].field === "payment_sequence_number" &&
      sorters[2].order === "asc";

    if (!isDefaultSort) {
      message.info("Сброс сортировки для поиска...");
      setSorters([
        { field: "payment_date", order: "desc" },
        { field: "order_name", order: "desc" },
        { field: "payment_sequence_number", order: "asc" },
      ]);
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    try {
      const token = authStorage.getAccessToken();
      if (!token) {
        message.error("Не авторизован. Пожалуйста, войдите в систему.");
        return;
      }

      // Шаг 1: Находим платёж по order_name (LIKE поиск)
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
              query FindPayment($orderNamePattern: String!) {
                payments_view(
                  where: { order_name: { _ilike: $orderNamePattern } }
                  order_by: [{ payment_date: desc }, { order_name: desc }, { payment_sequence_number: asc }]
                  limit: 1
                ) {
                  payment_id
                  order_name
                  payment_date
                  payment_sequence_number
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

      const payments = data.data?.payments_view || [];

      if (payments.length === 0) {
        message.error(`Платёж по заказу "${orderName}" не найден`);
        return;
      }

      const foundPayment = payments[0];
      const foundPaymentId = foundPayment.payment_id;
      const foundPaymentDate = foundPayment.payment_date;
      const foundOrderName = foundPayment.order_name;
      const foundSeqNum = foundPayment.payment_sequence_number;

      // Шаг 2: Считаем платежи "выше" найденного
      // Сортировка: payment_date DESC, order_name DESC, payment_sequence_number ASC
      // "Выше" значит: date больше, ИЛИ date равна И order_name больше, ИЛИ date равна И order_name равна И seq_num меньше
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
              query GetGreaterCount($paymentDate: date!, $orderName: String!, $seqNum: bigint!) {
                payments_view_aggregate(
                  where: {
                    _or: [
                      { payment_date: { _gt: $paymentDate } }
                      {
                        _and: [
                          { payment_date: { _eq: $paymentDate } }
                          { order_name: { _gt: $orderName } }
                        ]
                      }
                      {
                        _and: [
                          { payment_date: { _eq: $paymentDate } }
                          { order_name: { _eq: $orderName } }
                          { payment_sequence_number: { _lt: $seqNum } }
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
              paymentDate: foundPaymentDate,
              orderName: foundOrderName,
              seqNum: foundSeqNum,
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

      const greaterCount = countData.data?.payments_view_aggregate?.aggregate?.count || 0;

      // Вычисляем номер страницы
      const targetPage = Math.floor(greaterCount / pageSize) + 1;

      // Переключаем на нужную страницу
      if (targetPage !== current) {
        setCurrent(targetPage);
      }

      // Подсвечиваем найденную строку
      setHighlightedPaymentId(foundPaymentId);
      message.success(`Платёж по заказу "${foundPayment.order_name}" найден`);

      // Убираем подсветку через 3 секунды
      setTimeout(() => {
        setHighlightedPaymentId(null);
      }, 3000);
    } catch (error) {
      console.error("Ошибка поиска платежа:", error);
      message.error("Ошибка при поиске платежа");
    }
  }, [searchValue, pageSize, current, setCurrent, sorters, setSorters]);

  // Применение фильтров
  const handleFilter = (values: any) => {
    const newFilters: any[] = [];
    const hasValue = (val: any) => val !== undefined && val !== null && val !== "";

    // Строковые фильтры (contains/ilike)
    if (hasValue(values.order_name)) {
      newFilters.push({ field: "order_name", operator: "contains", value: values.order_name });
    }
    if (hasValue(values.client_name)) {
      newFilters.push({ field: "client_name", operator: "contains", value: values.client_name });
    }
    if (hasValue(values.notes)) {
      newFilters.push({ field: "notes", operator: "contains", value: values.notes });
    }

    // Статусы и типы (exact match)
    if (hasValue(values.type_paid_name)) {
      newFilters.push({ field: "type_paid_name", operator: "eq", value: values.type_paid_name });
    }
    if (hasValue(values.order_status_name)) {
      newFilters.push({ field: "order_status_name", operator: "eq", value: values.order_status_name });
    }
    if (hasValue(values.payment_status_name)) {
      newFilters.push({ field: "payment_status_name", operator: "eq", value: values.payment_status_name });
    }
    if (hasValue(values.production_status_name)) {
      newFilters.push({ field: "production_status_name", operator: "eq", value: values.production_status_name });
    }

    // Диапазоны дат
    if (values.payment_date_range && Array.isArray(values.payment_date_range) && values.payment_date_range.length === 2) {
      newFilters.push({ field: "payment_date", operator: "gte", value: values.payment_date_range[0].format("YYYY-MM-DD") });
      newFilters.push({ field: "payment_date", operator: "lte", value: values.payment_date_range[1].format("YYYY-MM-DD") });
    }
    if (values.order_date_range && Array.isArray(values.order_date_range) && values.order_date_range.length === 2) {
      newFilters.push({ field: "order_date", operator: "gte", value: values.order_date_range[0].format("YYYY-MM-DD") });
      newFilters.push({ field: "order_date", operator: "lte", value: values.order_date_range[1].format("YYYY-MM-DD") });
    }

    // Числовые диапазоны - сумма платежа
    if (hasValue(values.amount_min)) {
      newFilters.push({ field: "amount", operator: "gte", value: values.amount_min });
    }
    if (hasValue(values.amount_max)) {
      newFilters.push({ field: "amount", operator: "lte", value: values.amount_max });
    }

    // Сумма заказа
    if (hasValue(values.order_effective_final_amount_min)) {
      newFilters.push({ field: "order_effective_final_amount", operator: "gte", value: values.order_effective_final_amount_min });
    }
    if (hasValue(values.order_effective_final_amount_max)) {
      newFilters.push({ field: "order_effective_final_amount", operator: "lte", value: values.order_effective_final_amount_max });
    }

    // Всего оплат по заказу
    if (hasValue(values.total_payments_for_order_min)) {
      newFilters.push({ field: "total_payments_for_order", operator: "gte", value: values.total_payments_for_order_min });
    }
    if (hasValue(values.total_payments_for_order_max)) {
      newFilters.push({ field: "total_payments_for_order", operator: "lte", value: values.total_payments_for_order_max });
    }

    // Баланс заказа
    if (hasValue(values.order_balance_total_min)) {
      newFilters.push({ field: "order_balance_total", operator: "gte", value: values.order_balance_total_min });
    }
    if (hasValue(values.order_balance_total_max)) {
      newFilters.push({ field: "order_balance_total", operator: "lte", value: values.order_balance_total_max });
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

  // Цвет для статуса оплаты
  const getPaymentStatusColor = (status: string | null) => {
    if (status === 'Не оплачен') return '#ff4d4f';
    if (status === 'Частично оплачен') return '#d4a574';
    if (status === 'Оплачен') return '#52c41a';
    return undefined;
  };

  // Количество записей
  const totalRecords = tableProps?.pagination && typeof tableProps.pagination === 'object' ? tableProps.pagination.total || 0 : 0;

  return (
    <List
      title="+Платежи (аналитика)"
      headerButtons={() => (
        <>
          <Space.Compact style={{ marginRight: 8 }}>
            <Input
              placeholder="Быстрый поиск по заказу"
              value={searchValue}
              onChange={(e) => setSearchValue(e.target.value)}
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
            .range-group { display: flex; gap: 4px; }
            .range-group .ant-input-number { width: 55px !important; }
            .range-group-money .ant-input-number { width: 70px !important; }
            .filters-flex { display: flex; flex-wrap: wrap; gap: 16px 24px; align-items: flex-end; }
            .filters-flex > .filter-item { flex-shrink: 0; }
            .filters-flex > .filter-buttons { margin-left: auto; }
          `}</style>
          <Form form={form} layout="vertical" onFinish={handleFilter} className="filters-compact">
            <div className="filters-flex">
              {/* Даты */}
              <div className="filter-item">
                <Form.Item name="payment_date_range" label="Дата платежа">
                  <RangePicker style={{ width: 180 }} format="DD.MM.YY" size="small" />
                </Form.Item>
              </div>
              <div className="filter-item">
                <Form.Item name="order_date_range" label="Дата заказа">
                  <RangePicker style={{ width: 180 }} format="DD.MM.YY" size="small" />
                </Form.Item>
              </div>
              {/* Сумма платежа */}
              <div className="filter-item">
                <Form.Item label="Сумма платежа">
                  <div className="range-group range-group-money">
                    <Form.Item name="amount_min" noStyle>
                      <InputNumber
                        min={0}
                        placeholder="Мин"
                        size="small"
                        formatter={(value) => `${value}`.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}
                        parser={(value) => value?.replace(/\s/g, '') as unknown as number}
                      />
                    </Form.Item>
                    <Form.Item name="amount_max" noStyle>
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
              {/* Способ оплаты */}
              <div className="filter-item">
                <Form.Item name="type_paid_name" label="Способ оплаты">
                  <Select {...paymentTypeSelectProps} allowClear placeholder="Все" size="small" style={{ width: 120 }} />
                </Form.Item>
              </div>
              {/* Строковые фильтры */}
              <div className="filter-item">
                <Form.Item name="order_name" label="Заказ">
                  <Input allowClear placeholder="Содерж..." size="small" style={{ width: 90 }} />
                </Form.Item>
              </div>
              <div className="filter-item">
                <Form.Item name="client_name" label="Клиент">
                  <Input allowClear placeholder="Содерж..." size="small" style={{ width: 100 }} />
                </Form.Item>
              </div>
              <div className="filter-item">
                <Form.Item name="notes" label="Примечание">
                  <Input allowClear placeholder="Содерж..." size="small" style={{ width: 90 }} />
                </Form.Item>
              </div>
              {/* Статусы */}
              <div className="filter-item">
                <Form.Item name="order_status_name" label="Статус заказа">
                  <Select {...orderStatusSelectProps} allowClear placeholder="Все" size="small" style={{ width: 120 }} />
                </Form.Item>
              </div>
              <div className="filter-item">
                <Form.Item name="payment_status_name" label="Статус оплаты">
                  <Select {...paymentStatusSelectProps} allowClear placeholder="Все" size="small" style={{ width: 120 }} />
                </Form.Item>
              </div>
              <div className="filter-item">
                <Form.Item name="production_status_name" label="Статус произв.">
                  <Select {...productionStatusSelectProps} allowClear placeholder="Все" size="small" style={{ width: 120 }} />
                </Form.Item>
              </div>
              {/* Сумма заказа */}
              <div className="filter-item">
                <Form.Item label="Сумма заказа">
                  <div className="range-group range-group-money">
                    <Form.Item name="order_effective_final_amount_min" noStyle>
                      <InputNumber
                        min={0}
                        placeholder="Мин"
                        size="small"
                        formatter={(value) => `${value}`.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}
                        parser={(value) => value?.replace(/\s/g, '') as unknown as number}
                      />
                    </Form.Item>
                    <Form.Item name="order_effective_final_amount_max" noStyle>
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
              {/* Оплаты по заказу */}
              <div className="filter-item">
                <Form.Item label="Оплаты по заказу">
                  <div className="range-group range-group-money">
                    <Form.Item name="total_payments_for_order_min" noStyle>
                      <InputNumber
                        min={0}
                        placeholder="Мин"
                        size="small"
                        formatter={(value) => `${value}`.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}
                        parser={(value) => value?.replace(/\s/g, '') as unknown as number}
                      />
                    </Form.Item>
                    <Form.Item name="total_payments_for_order_max" noStyle>
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
              {/* Баланс заказа */}
              <div className="filter-item">
                <Form.Item label="Баланс заказа">
                  <div className="range-group range-group-money">
                    <Form.Item name="order_balance_total_min" noStyle>
                      <InputNumber
                        placeholder="Мин"
                        size="small"
                        formatter={(value) => `${value}`.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}
                        parser={(value) => value?.replace(/\s/g, '') as unknown as number}
                      />
                    </Form.Item>
                    <Form.Item name="order_balance_total_max" noStyle>
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
        rowKey="payment_id"
        sticky
        scroll={{ x: "max-content", y: 600 }}
        rowClassName={(record) =>
          record.payment_id === highlightedPaymentId ? "highlighted-row" : ""
        }
        onRow={(record) => ({
          onDoubleClick: () => {
            show("payments_view", record.payment_id, "push");
          },
        })}
      >
        <Table.Column
          dataIndex="payment_date"
          title="Дата платежа"
          sorter
          width={110}
          render={(value) => formatDate(value)}
        />
        <Table.Column
          dataIndex="amount"
          title="Сумма"
          sorter
          width={110}
          align="right"
          render={(value) => (
            <span style={{ fontWeight: 500, color: '#52c41a' }}>
              {formatNumber(value as number, 0)}
            </span>
          )}
        />
        <Table.Column
          dataIndex="type_paid_name"
          title="Тип оплаты"
          width={120}
        />
        <Table.Column
          dataIndex="order_name"
          title="Заказ"
          sorter
          width={100}
          render={(value, record: any) => (
            <Tooltip title={`Перейти к заказу #${record.order_id}`}>
              <span style={{ color: '#1890ff', cursor: 'pointer' }}>
                {value}
              </span>
            </Tooltip>
          )}
        />
        <Table.Column
          dataIndex="client_name"
          title="Клиент"
          width={150}
        />
        <Table.Column
          dataIndex="order_date"
          title="Дата заказа"
          sorter
          width={110}
          render={(value) => formatDate(value)}
        />
        <Table.Column
          dataIndex="order_effective_final_amount"
          title="Сумма заказа"
          width={110}
          align="right"
          render={(value) => formatNumber(value as number, 0)}
        />
        <Table.Column
          dataIndex="payment_sequence_number"
          title="№ п/п"
          width={60}
          align="center"
          render={(value) => (
            <Tooltip title="Порядковый номер платежа в заказе">
              <span>{value}</span>
            </Tooltip>
          )}
        />
        <Table.Column
          dataIndex="cumulative_payment_for_order"
          title={<div style={{ textAlign: 'center' }}>Нараст. итог</div>}
          width={110}
          align="right"
          render={(value) => (
            <Tooltip title="Накопительная сумма платежей по заказу">
              <span>{formatNumber(value as number, 0)}</span>
            </Tooltip>
          )}
        />
        <Table.Column
          dataIndex="order_balance_after_this_payment"
          title={<div style={{ textAlign: 'center' }}>Остаток после платежа</div>}
          width={130}
          align="right"
          render={(value) => (
            <span style={{ color: value > 0 ? '#ff4d4f' : '#52c41a' }}>
              {formatNumber(value as number, 0)}
            </span>
          )}
        />
        <Table.Column
          dataIndex="total_payments_for_order"
          title={<div style={{ textAlign: 'center' }}>Всего оплачено</div>}
          width={120}
          align="right"
          render={(value) => formatNumber(value as number, 0)}
        />
        <Table.Column
          dataIndex="order_balance_total"
          title={<div style={{ textAlign: 'center' }}>Баланс заказа</div>}
          width={110}
          align="right"
          render={(value) => (
            <span style={{ color: value > 0 ? '#ff4d4f' : '#52c41a', fontWeight: 500 }}>
              {formatNumber(value as number, 0)}
            </span>
          )}
        />
        <Table.Column
          dataIndex="payment_status_name"
          title="Статус оплаты"
          width={120}
          render={(value) => (
            <span style={{ color: getPaymentStatusColor(value), fontWeight: 500 }}>
              {value || "—"}
            </span>
          )}
        />
        <Table.Column
          dataIndex="order_status_name"
          title="Статус заказа"
          width={120}
        />
        <Table.Column
          dataIndex="notes"
          title="Примечание"
          width={150}
          ellipsis
          render={(value) => (
            <Tooltip title={value}>
              <span>{value || "—"}</span>
            </Tooltip>
          )}
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
                recordItemId={record.payment_id}
              />
            </Space>
          )}
        />
      </Table>
    </List>
  );
};
