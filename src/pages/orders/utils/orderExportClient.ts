type ClientLike = {
  client_name?: unknown;
  clientName?: unknown;
} | null | undefined;

type BackendOrderLike = {
  header?: ClientLike;
} | null | undefined;

export function resolveOrderExportClientName(
  record?: ClientLike,
  backendOrder?: BackendOrderLike,
  clientRecord?: ClientLike,
): string | null {
  return firstNonEmptyText(
    record?.client_name,
    record?.clientName,
    backendOrder?.header?.client_name,
    backendOrder?.header?.clientName,
    clientRecord?.client_name,
    clientRecord?.clientName,
  );
}

export function toOrderExportClient(clientName: string | null): { client_name: string } | null {
  return clientName ? { client_name: clientName } : null;
}

function firstNonEmptyText(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== 'string') continue;

    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }

  return null;
}
