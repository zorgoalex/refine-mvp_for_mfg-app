import { useEffect, useMemo, useState } from 'react';
import { useKBar, useRegisterActions } from '@refinedev/kbar';
import { useDataProvider } from '@refinedev/core';
import { useNavigate } from 'react-router-dom';
import { ordersApi } from '../../api/ordersApi';
import { featureFlags } from '../../config/featureFlags';
import { useEvolutionNavigation } from './useEvolutionNavigation';
import {
  KBAR_RECORD_SEARCH_DEBOUNCE_MS,
  KBAR_RECORD_SEARCH_LIMIT,
  buildKbarRecordActions,
  kbarRecordSearchTerm,
  type KbarFoundClient,
  type KbarFoundOrder,
} from './workbenchKbarSearch';

interface Found {
  term: string;
  orders: KbarFoundOrder[];
  clients: KbarFoundClient[];
}

const EMPTY: Found = { term: '', orders: [], clients: [] };

/** «NewLine»: Ctrl+K ищет заказы по номеру и клиентов по имени (см. workbenchKbarSearch.ts). Ничего не рисует. */
export function WorkbenchKbarRecordSearch(): null {
  const { searchQuery, visible } = useKBar((state) => ({
    searchQuery: state.searchQuery,
    visible: state.visualState !== 'hidden',
  }));
  const navigate = useNavigate();
  const dataProvider = useDataProvider();
  const { canViewNavigation } = useEvolutionNavigation();
  const canSearchOrders = featureFlags.useBackendOrdersRead && canViewNavigation('orders_view');
  const canSearchClients = canViewNavigation('clients');
  const [found, setFound] = useState<Found>(EMPTY);

  const term = visible ? kbarRecordSearchTerm(searchQuery) : null;

  useEffect(() => {
    if (!term || (!canSearchOrders && !canSearchClients)) {
      setFound(EMPTY);
      return undefined;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      const ordersRequest: Promise<KbarFoundOrder[]> = canSearchOrders
        ? ordersApi
          .list({ page: 1, pageSize: KBAR_RECORD_SEARCH_LIMIT, search: term, sortBy: 'orderDate', sortOrder: 'desc' })
          .then((response) => response.data)
          .catch(() => [])
        : Promise.resolve([]);
      const clientsRequest: Promise<KbarFoundClient[]> = canSearchClients
        ? dataProvider()
          .getList({
            resource: 'clients',
            pagination: { current: 1, pageSize: KBAR_RECORD_SEARCH_LIMIT },
            filters: [{ field: 'client_name', operator: 'contains', value: term }],
            sorters: [{ field: 'client_name', order: 'asc' }],
          })
          .then((response) => (response.data as Array<{ client_id: number; client_name: string | null }>)
            .filter((row) => row.client_name)
            .map((row) => ({ clientId: row.client_id, clientName: String(row.client_name) })))
          .catch(() => [])
        : Promise.resolve([]);
      void Promise.all([ordersRequest, clientsRequest]).then(([orders, clients]) => {
        // ответ на уже изменённую строку не показываем
        if (!cancelled) setFound({ term, orders, clients });
      });
    }, KBAR_RECORD_SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [canSearchClients, canSearchOrders, dataProvider, term]);

  const actions = useMemo(
    () => (found.term && found.term === term ? buildKbarRecordActions(found.term, found.orders, found.clients, navigate) : []),
    [found, navigate, term],
  );
  useRegisterActions(actions, [actions]);
  return null;
}
