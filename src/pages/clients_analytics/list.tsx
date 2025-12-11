import React, { useState, useCallback, useEffect } from "react";
import { IResourceComponentsProps, useNavigation } from "@refinedev/core";
import { List, useTable, ShowButton } from "@refinedev/antd";
import { Space, Table, Badge, Input, Button, message, Tooltip, Typography } from "antd";
import { SearchOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import { formatNumber } from "../../utils/numberFormat";
import { authStorage } from "../../utils/auth";

const { Text } = Typography;

export const ClientsAnalyticsList: React.FC<IResourceComponentsProps> = () => {
  const [searchValue, setSearchValue] = useState<string>("");
  const [highlightedClientId, setHighlightedClientId] = useState<number | null>(null);

  const { tableProps, current, pageSize, setCurrent, sorters, setSorters } = useTable({
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

  // Обработчик поиска клиента
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

      // Шаг 1: Находим клиента по client_name (LIKE поиск)
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
        console.error("GraphQL ошибка:", data.errors);
        return;
      }

      const clients = data.data?.clients_analytics_view || [];

      if (clients.length === 0) {
        message.error(`Клиент "${clientName}" не найден`);
        return;
      }

      const foundClient = clients[0];
      const foundClientId = foundClient.client_id;

      // Шаг 2: Получаем количество клиентов с client_id > найденного (для DESC сортировки)
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
        const errorMessage = countData.errors[0]?.message || "Ошибка подсчета";
        message.error(errorMessage);
        console.error("GraphQL ошибка при подсчете:", countData.errors);
        return;
      }

      const greaterCount = countData.data?.clients_analytics_view_aggregate?.aggregate?.count || 0;

      // Вычисляем номер страницы
      const targetPage = Math.floor(greaterCount / pageSize) + 1;

      // Переключаем на нужную страницу
      if (targetPage !== current) {
        setCurrent(targetPage);
      }

      // Подсвечиваем найденную строку
      setHighlightedClientId(foundClientId);
      message.success(`Клиент "${foundClient.client_name}" найден`);

      // Убираем подсветку через 3 секунды
      setTimeout(() => {
        setHighlightedClientId(null);
      }, 3000);
    } catch (error) {
      console.error("Ошибка поиска клиента:", error);
      message.error("Ошибка при поиске клиента");
    }
  }, [searchValue, pageSize, current, setCurrent, sorters, setSorters]);

  const formatDate = (date: string | null) => {
    if (!date) return "—";
    return dayjs(date).format("DD.MM.YYYY");
  };

  return (
    <List
      title="+Клиенты (аналитика)"
      headerButtons={() => (
        <Space.Compact>
          <Input
            placeholder="Поиск по имени клиента"
            value={searchValue}
            onChange={(e) => setSearchValue(e.target.value)}
            onPressEnter={handleSearchClient}
            style={{ width: 250 }}
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
      )}
    >
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
          dataIndex="final_amount_sum"
          title="Сумма заказов"
          sorter
          width={120}
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
