import { createHash } from 'node:crypto';

/**
 * Idempotency anchor for a cut calculation (plan §12). The hash is a function of
 * the RESOLVED item set + params: a recalculate that does not change items+params
 * keeps the same request_hash (outbox insert is a no-op via the UNIQUE
 * idempotency_key), while adding/removing an order changes the item set ->
 * different hash -> new outbox row -> the relay resolves the current owner set.
 */
/** Canonical per-detail fields that affect the cut RESULT (geometry + cuttable key). */
export interface ResolvedHashItem {
  detailId: number;
  qty: number;
  widthMm: number;
  heightMm: number;
  sheetMaterialTypeId: number | null;
  filmId: number | null;
  filmTexture: boolean | null;
}

export interface ComputeRequestHashInput {
  /** resolved item set actually sent to freecut (order-independent) */
  items: readonly ResolvedHashItem[];
  /** freecut params snapshot */
  params: Record<string, unknown>;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = canonicalize((value as Record<string, unknown>)[key]);
        return acc;
      }, {});
  }
  return value;
}

export function computeRequestHash(input: ComputeRequestHashInput): string {
  // Sort items by detailId so the hash is order-independent. Geometry / material
  // / film / qty changes alter the hash even when the detail-id set is unchanged,
  // so a re-cut of changed details emits a fresh outbox row (not suppressed).
  const items = [...input.items]
    .map((item) => ({
      detailId: item.detailId,
      qty: item.qty,
      widthMm: item.widthMm,
      heightMm: item.heightMm,
      sheetMaterialTypeId: item.sheetMaterialTypeId,
      filmId: item.filmId,
      filmTexture: item.filmTexture,
    }))
    .sort((a, b) => a.detailId - b.detailId);
  const payload = canonicalize({ items, params: input.params });
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}
