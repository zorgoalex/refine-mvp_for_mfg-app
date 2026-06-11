import { hasuraReportQuery } from '../hasuraReportClient';

export interface OrderSearchRow {
  order_id: number;
  order_name: string;
  order_name_numeric: number | null;
  order_date: string;
}

const FIND_ORDER_QUERY = `
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
            `;

const COUNT_ORDERS_QUERY = `
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
            `;

export async function findOrderByName(orderName: string): Promise<OrderSearchRow | null> {
  const data = await hasuraReportQuery<{ orders_view: OrderSearchRow[] }>(FIND_ORDER_QUERY, {
    orderNamePattern: `%${orderName}%`,
  });
  return data.orders_view[0] ?? null;
}

export async function countOrdersAfter(args: { orderDate: string; orderNameNumeric: number | null }): Promise<number> {
  const data = await hasuraReportQuery<{ orders_view_aggregate: { aggregate: { count: number } } }>(
    COUNT_ORDERS_QUERY,
    { orderDate: args.orderDate, orderNameNumeric: args.orderNameNumeric },
  );
  return data.orders_view_aggregate?.aggregate?.count ?? 0;
}
