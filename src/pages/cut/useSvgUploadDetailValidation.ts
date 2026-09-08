import { useEffect, useState } from 'react';
import { cutApi } from '../../api/cutApi';
import type { EligibleDetailDto } from '../../api/types/cutApi.types';

type ValidationResult = {
  scopeKey: string;
  status: 'ready' | 'error';
  details: EligibleDetailDto[];
};

/** Never expose a previous file/order scope as the current validation result. */
export function useSvgUploadDetailValidation({ enabled, sourceKey, orderIds }: {
  enabled: boolean;
  sourceKey: string | null;
  orderIds: number[];
}): { status: 'idle' | 'loading' | 'ready' | 'error'; details: EligibleDetailDto[] } {
  const scopeKey = enabled && sourceKey && orderIds.length
    ? JSON.stringify({ sourceKey, orderIds }) : null;
  const [result, setResult] = useState<ValidationResult | null>(null);

  useEffect(() => {
    setResult(null);
    if (scopeKey === null) return;
    let cancelled = false;
    const scope = JSON.parse(scopeKey) as { orderIds: number[] };
    void cutApi.listEligibleDetailsPreview({ orderIds: scope.orderIds })
      .then(response => {
        if (!cancelled) setResult({ scopeKey, status: 'ready', details: response.details });
      })
      .catch(() => {
        if (!cancelled) setResult({ scopeKey, status: 'error', details: [] });
      });
    return () => { cancelled = true; };
  }, [scopeKey]);

  if (scopeKey === null) return { status: 'idle', details: [] };
  // Invalidate during render, before the new request effect runs.
  if (result?.scopeKey !== scopeKey) return { status: 'loading', details: [] };
  return { status: result.status, details: result.details };
}
