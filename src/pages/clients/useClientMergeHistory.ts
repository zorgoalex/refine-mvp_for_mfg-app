import { useCallback, useEffect, useState } from 'react';
import { clientMergesApi } from '../../api/clientMergesApi';
import type { ClientMergeHistory } from '../../api/clientMergesApiTypes';
import { can } from '../../utils/permissions';

/** Merge history of a client; loaded only with `clients.view`, any failure just leaves it empty. */
export function useClientMergeHistory(clientId: number | null) {
  const [history, setHistory] = useState<ClientMergeHistory | null>(null);
  const [version, setVersion] = useState(0);
  const allowed = can('clients.view');

  useEffect(() => {
    if (!clientId || !allowed) {
      setHistory(null);
      return;
    }
    let cancelled = false;
    clientMergesApi.history(clientId)
      .then((result) => { if (!cancelled) setHistory(result); })
      .catch(() => { if (!cancelled) setHistory(null); });
    return () => { cancelled = true; };
  }, [clientId, allowed, version]);

  const reload = useCallback(() => setVersion((value) => value + 1), []);
  return { history, reload };
}
