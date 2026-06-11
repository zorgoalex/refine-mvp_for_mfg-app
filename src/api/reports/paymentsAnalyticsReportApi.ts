import { hasuraReportQuery } from '../hasuraReportClient';

export interface PaymentSearchRow {
  payment_id: number;
  payment_date: string;
  order_name: string;
  payment_sequence_number: number;
}

const FIND_QUERY = `
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
            `;

const COUNT_QUERY = `
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
            `;

export async function findPaymentByOrderName(orderName: string): Promise<PaymentSearchRow | null> {
  const data = await hasuraReportQuery<{ payments_view: PaymentSearchRow[] }>(FIND_QUERY, {
    orderNamePattern: `%${orderName}%`,
  });
  return data.payments_view[0] ?? null;
}

export async function countPaymentsAfter(args: { paymentDate: string; orderName: string; seqNum: number }): Promise<number> {
  const data = await hasuraReportQuery<{ payments_view_aggregate: { aggregate: { count: number } } }>(
    COUNT_QUERY,
    { paymentDate: args.paymentDate, orderName: args.orderName, seqNum: args.seqNum },
  );
  return data.payments_view_aggregate?.aggregate?.count ?? 0;
}
