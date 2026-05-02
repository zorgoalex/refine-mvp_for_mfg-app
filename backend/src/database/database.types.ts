import type { PoolClient, QueryResult, QueryResultRow } from 'pg';

export interface DatabaseQueryOptions {
  timeoutMs?: number;
}

export interface DatabaseClient {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: readonly unknown[],
    options?: DatabaseQueryOptions,
  ): Promise<QueryResult<T>>;
}

export interface TransactionClient extends DatabaseClient {
  readonly raw: PoolClient;
}
