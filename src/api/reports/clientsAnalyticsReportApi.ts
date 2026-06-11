import { hasuraReportQuery } from '../hasuraReportClient';

export interface ClientAnalyticsRow { client_id: number; client_name: string }

const FIND_QUERY = `
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
            `;
const COUNT_QUERY = `
              query GetGreaterCount($clientId: bigint!) {
                clients_analytics_view_aggregate(
                  where: { client_id: { _gt: $clientId } }
                ) {
                  aggregate {
                    count
                  }
                }
              }
            `;

export async function findClientAnalyticsByName(clientName: string): Promise<ClientAnalyticsRow | null> {
  const data = await hasuraReportQuery<{ clients_analytics_view: ClientAnalyticsRow[] }>(FIND_QUERY, {
    clientNamePattern: `%${clientName}%`,
  });
  return data.clients_analytics_view[0] ?? null;
}

export async function countClientsAnalyticsAfter(clientId: number): Promise<number> {
  const data = await hasuraReportQuery<{ clients_analytics_view_aggregate: { aggregate: { count: number } } }>(
    COUNT_QUERY,
    { clientId },
  );
  return data.clients_analytics_view_aggregate?.aggregate?.count ?? 0;
}
