import { hasuraReportQuery } from '../hasuraReportClient';

export interface ClientSearchRow {
  client_id: number;
  client_name: string;
}

const FIND_CLIENT_QUERY = `
              query FindClient($clientNamePattern: citext!) {
                clients(
                  where: {
                    client_name: { _ilike: $clientNamePattern }
                    is_active: { _eq: true }
                  }
                  order_by: [{ client_id: desc }]
                  limit: 1
                ) {
                  client_id
                  client_name
                }
              }
            `;

const COUNT_CLIENTS_QUERY = `
              query GetGreaterCount($clientId: bigint!) {
                clients_aggregate(
                  where: {
                    client_id: { _gt: $clientId }
                    is_active: { _eq: true }
                  }
                ) {
                  aggregate {
                    count
                  }
                }
              }
            `;

export async function findClientByName(clientName: string): Promise<ClientSearchRow | null> {
  const data = await hasuraReportQuery<{ clients: ClientSearchRow[] }>(FIND_CLIENT_QUERY, {
    clientNamePattern: `%${clientName}%`,
  });
  return data.clients[0] ?? null;
}

export async function countClientsAfter(clientId: number): Promise<number> {
  const data = await hasuraReportQuery<{ clients_aggregate: { aggregate: { count: number } } }>(
    COUNT_CLIENTS_QUERY,
    { clientId },
  );
  return data.clients_aggregate?.aggregate?.count ?? 0;
}
