import { useMemo } from 'react';
import { useList } from '@refinedev/core';
import { featureFlags } from '../../config/featureFlags';
import { can } from '../../utils/permissions';
import { clientScreenClientContacts, type ClientScreenClientContacts } from './orderEditSnapshotSource';

/**
 * Phones of the order's client for the customer screen: the same read the order header does for its
 * own phone line (the query is shared with it), only while this order is presented and only when the
 * manager may see clients. Until they are loaded nothing of them is sent.
 */
export function useClientScreenClientContacts(clientId: number | null | undefined, presented: boolean): ClientScreenClientContacts {
  const allowed = !featureFlags.useBackendPermissions || can('clients.view');
  const enabled = presented && allowed && clientId !== null && clientId !== undefined;
  const { data } = useList({
    resource: 'client_phones',
    filters: [{ field: 'client_id', operator: 'eq', value: clientId }],
    pagination: { pageSize: 100 },
    queryOptions: { enabled },
  });
  const rows = enabled ? data?.data : undefined;
  return useMemo(() => clientScreenClientContacts(rows as never), [rows]);
}
