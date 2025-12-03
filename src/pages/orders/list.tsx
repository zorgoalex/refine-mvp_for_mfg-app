import React, { useMemo, useState, useCallback, useEffect } from "react";
import {
  IResourceComponentsProps,
  useMany,
  useNavigation,
  useList,
  useOne,
  HttpError,
} from "@refinedev/core";
import {
  List,
  useTable,
  ShowButton,
  EditButton,
  CreateButton,
} from "@refinedev/antd";
import { Space, Table, Button, Input, message, Tooltip } from "antd";
import {
  EyeOutlined,
  EditOutlined,
  PlusOutlined,
  StarFilled,
  SearchOutlined,
} from "@ant-design/icons";
import dayjs from "dayjs";

import { formatNumber } from "../../utils/numberFormat";
import { OrderCreateModal } from "./components/OrderCreateModal";
import { authStorage } from "../../utils/auth";
import "./list.css";

export const OrderList: React.FC<IResourceComponentsProps> = () => {
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [searchOrderId, setSearchOrderId] = useState<string>("");
  const [highlightedOrderId, setHighlightedOrderId] = useState<number | null>(null);

  const { tableProps, current, pageSize, setCurrent, sorters, setSorters } = useTable({
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

      // Шаг 1: Находим заказ по order_name
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
              query FindOrder($orderName: String!) {
                orders_view(
                  where: { order_name: { _eq: $orderName } }
                  limit: 1
                ) {
                  order_id
                  order_name
                  order_name_numeric
                  order_date
                }
              }
            `,
            variables: { orderName },
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
        message.error(`Заказ №${orderName} не найден`);
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
      message.success(`Заказ №${orderName} найден`);

      // Убираем подсветку через 3 секунды
      setTimeout(() => {
        setHighlightedOrderId(null);
      }, 3000);
    } catch (error) {
      console.error("Ошибка поиска заказа:", error);
      message.error("Ошибка при поиске заказа");
    }
  }, [searchOrderId, pageSize, current, setCurrent, sorters, setSorters]);

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

  // Функция: возвращает уникальные значения материалов через запятую
  const getMaterialsList = (orderId: number) => {
    const details = detailsByOrderId[orderId] || [];
    if (details.length === 0) return "—";

    const materialIds = details
      .map((d) => d.material_id)
      .filter((v) => v !== null && v !== undefined);

    const uniqueMaterialIds = Array.from(new Set(materialIds));
    const materialNames = uniqueMaterialIds
      .map((id) => materialsMap[id])
      .filter((name) => name);

    return materialNames.length > 0 ? materialNames.join(", ") : "—";
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
              ) : "—";
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
              const value = millingTypeId ? millingTypesMap[millingTypeId] || "—" : "—";
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
            width={90}
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
            width={45}
            className="orders-col status order-status orders-col--wrap"
            render={(value) => renderStatus(value)}
          />
          <Table.Column
            dataIndex="payment_status_name"
            title="Статус оплаты заказа"
            width={45}
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
            dataIndex="discounted_amount"
            title="Сумма, итого"
            sorter
            width={90}
            className="orders-col orders-col--amount"
            render={(value) => formatNumber(value as number, 0)}
          />
          <Table.Column
            dataIndex="production_status_name"
            title="Статус произ-ва"
            width={90}
            className="orders-col status production-status orders-col--wrap"
            render={(value) => renderStatus(value)}
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
            key="design_engineer"
            title="Конструктор"
            width={100}
            className="orders-col orders-col--wrap"
            render={(_, record: any) => {
              const latestLink = getLatestDoweling(record.order_id);
              const engineerId = latestLink?.doweling_order?.design_engineer_id;
              return engineerId ? employeesMap[engineerId] || "—" : "—";
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
              return edgeTypeId ? edgeTypesMap[edgeTypeId] || "—" : "—";
            }}
          />
          <Table.Column
            dataIndex="film_name"
            title="Пленка"
            width={120}
            className="orders-col orders-col--wrap"
            render={(_, record: any) => {
              const filmId = getCommonValue(record.order_id, "film_id");
              return filmId ? filmsMap[filmId] || "—" : "—";
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

