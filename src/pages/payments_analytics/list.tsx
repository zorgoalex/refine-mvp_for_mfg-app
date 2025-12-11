import React, { useState, useCallback, useEffect } from "react";
import { IResourceComponentsProps, useNavigation } from "@refinedev/core";
import { List, useTable, ShowButton } from "@refinedev/antd";
import { Space, Table, Input, Button, message, Tooltip, Typography } from "antd";
import { SearchOutlined, LinkOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import { formatNumber } from "../../utils/numberFormat";
import { authStorage } from "../../utils/auth";

const { Text } = Typography;

export const PaymentsAnalyticsList: React.FC<IResourceComponentsProps> = () => {
  const [searchValue, setSearchValue] = useState<string>("");
  const [highlightedPaymentId, setHighlightedPaymentId] = useState<number | null>(null);

  const { tableProps, current, pageSize, setCurrent, sorters, setSorters } = useTable({
    syncWithLocation: true,
    sorters: {
      initial: [
        { field: "payment_date", order: "desc" },
        { field: "payment_id", order: "desc" },
      ],
    },
    pagination: {
      mode: "server",
      pageSize: 20,
    },
  });

  const { show } = useNavigation();

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

    // Сбрасываем сортировку на payment_date DESC, payment_id DESC перед поиском
    const isDefaultSort =
      sorters.length >= 2 &&
      sorters[0].field === "payment_date" &&
      sorters[0].order === "desc" &&
      sorters[1].field === "payment_id" &&
      sorters[1].order === "desc";

    if (!isDefaultSort) {
      message.info("Сброс сортировки для поиска...");
      setSorters([
        { field: "payment_date", order: "desc" },
        { field: "payment_id", order: "desc" },
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
                  order_by: [{ payment_date: desc }, { payment_id: desc }]
                  limit: 1
                ) {
                  payment_id
                  order_name
                  payment_date
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

      // Шаг 2: Считаем платежи "выше" найденного
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
              query GetGreaterCount($paymentDate: date!, $paymentId: bigint!) {
                payments_view_aggregate(
                  where: {
                    _or: [
                      { payment_date: { _gt: $paymentDate } }
                      {
                        _and: [
                          { payment_date: { _eq: $paymentDate } }
                          { payment_id: { _gt: $paymentId } }
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
              paymentId: foundPaymentId,
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

  return (
    <List
      title="+Платежи (аналитика)"
      headerButtons={() => (
        <Space.Compact>
          <Input
            placeholder="Поиск по номеру заказа"
            value={searchValue}
            onChange={(e) => setSearchValue(e.target.value)}
            onPressEnter={handleSearchOrder}
            style={{ width: 250 }}
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
      )}
    >
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
          title="Накопл."
          width={100}
          align="right"
          render={(value) => (
            <Tooltip title="Накопительная сумма платежей по заказу">
              <span>{formatNumber(value as number, 0)}</span>
            </Tooltip>
          )}
        />
        <Table.Column
          dataIndex="order_balance_after_this_payment"
          title="Остаток"
          width={100}
          align="right"
          render={(value) => (
            <span style={{ color: value > 0 ? '#ff4d4f' : '#52c41a' }}>
              {formatNumber(value as number, 0)}
            </span>
          )}
        />
        <Table.Column
          dataIndex="total_payments_for_order"
          title="Всего оплат"
          width={100}
          align="right"
          render={(value) => formatNumber(value as number, 0)}
        />
        <Table.Column
          dataIndex="order_balance_total"
          title="Баланс"
          width={100}
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
