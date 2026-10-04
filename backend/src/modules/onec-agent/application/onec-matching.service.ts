import { Inject, Injectable } from '@nestjs/common';
import { ApiError } from '../../../common/errors/api-error';
import { PgOnecMatchingRepository, type CounterpartyMatchStatus } from '../adapters/pg-onec-matching-repository';
import { PgOnecRepository } from '../adapters/pg-onec-repository';
import { OnecRuntimeConfigService } from '../onec-runtime-config.service';

const STATUSES = ['all', 'matched', 'ambiguous', 'unmatched'] as const;
const ROLES = ['all', 'buyer', 'supplier'] as const;

/**
 * «Сопоставление» (plan §9, E3c): how the 1C copy lines up with ERP reference data. Read-only —
 * nothing in ERP or in the copy changes; binding 1C keys to ERP rows is E4.
 */
@Injectable()
export class OnecMatchingService {
  constructor(
    @Inject(PgOnecMatchingRepository) private readonly matching: PgOnecMatchingRepository,
    @Inject(PgOnecRepository) private readonly repository: PgOnecRepository,
    @Inject(OnecRuntimeConfigService) private readonly runtime: OnecRuntimeConfigService,
  ) {}

  private async sourceOf(agentId: string | undefined): Promise<number> {
    this.runtime.requireEnabled();
    if (!agentId) throw new ApiError(400, 'VALIDATION_FAILED', 'Нужен агент');
    const agent = await this.repository.getAgent(this.repository.db, agentId);
    if (!agent) throw new ApiError(404, 'ONEC_AGENT_NOT_FOUND', 'Агент не найден');
    return agent.sourceId;
  }

  async counterparties(query: { agentId?: string; status?: string; role?: string; search?: string; offset?: string; limit?: string }) {
    const sourceId = await this.sourceOf(query.agentId);
    const status = STATUSES.find((value) => value === query.status) ?? 'all';
    const role = ROLES.find((value) => value === query.role) ?? 'all';
    const limit = intParam(query.limit, 50, 1, 200, 'limit');
    const offset = intParam(query.offset, 0, 0, 1_000_000, 'offset');
    const search = query.search?.trim() ? query.search.trim().slice(0, 100) : null;
    const filter = { sourceId, status: status as CounterpartyMatchStatus | 'all', role, search, offset, limit };
    const [summary, rows, total, trigram] = await Promise.all([
      this.matching.counterpartySummary(sourceId),
      this.matching.counterparties(filter),
      this.matching.counterpartyCount(filter),
      this.matching.trigramAvailable(),
    ]);
    const unmatchedNames = rows.filter((row) => row.status === 'unmatched' && row.name).map((row) => row.name as string);
    const suggestions = trigram ? await this.matching.suggestions(unmatchedNames) : new Map();
    return {
      summary: {
        total: summary.total,
        buyers: summary.buyers,
        suppliers: summary.suppliers,
        matched: summary.matched,
        ambiguous: summary.ambiguous,
        unmatched: summary.unmatched,
        byRefKey: summary.by_ref_key,
        byName: summary.by_name,
        byPhone: summary.by_phone,
      },
      suggestionsAvailable: trigram,
      total,
      rows: rows.map((row) => ({
        sourceKey: row.source_key,
        code: row.code,
        name: row.name,
        fullName: row.full_name,
        bin: row.bin || null,
        binValid: row.bin_valid ?? null,
        buyer: row.buyer,
        supplier: row.supplier,
        deleted: row.deleted,
        missing: row.missing,
        status: row.status,
        matches: row.matches,
        suggestions: row.status === 'unmatched'
          ? (suggestions.get(row.name) ?? []).map((s: { kind: string; id: string; name: string; score: number }) => ({ kind: s.kind, id: Number(s.id), name: s.name, score: Math.round(Number(s.score) * 100) / 100 }))
          : [],
      })),
    };
  }

  async itemDistribution(agentId: string | undefined) {
    const sourceId = await this.sourceOf(agentId);
    const rows = await this.matching.itemDistribution(sourceId);
    const categories = new Map<string, {
      categoryKey: string | null;
      categoryName: string | null;
      defaultType: string | null;
      total: number;
      deleted: number;
      /** Items absent from the latest full read (diagnostics, not counted in total). */
      missing: number;
      withPrice: number;
      withStock: number;
      byType: Array<{ type: string; total: number }>;
    }>();
    for (const row of rows) {
      const key = row.category_key ?? '';
      const entry = categories.get(key) ?? {
        categoryKey: row.category_key ?? null,
        categoryName: row.category_name ?? null,
        defaultType: row.category_default_type ?? null,
        total: 0,
        deleted: 0,
        missing: 0,
        withPrice: 0,
        withStock: 0,
        byType: [] as Array<{ type: string; total: number }>,
      };
      entry.total += Number(row.total);
      entry.deleted += Number(row.deleted);
      entry.missing += Number(row.missing);
      entry.withPrice += Number(row.with_price);
      entry.withStock += Number(row.with_stock);
      if (Number(row.total) > 0) entry.byType.push({ type: row.item_type, total: Number(row.total) });
      categories.set(key, entry);
    }
    const list = [...categories.values()].sort((a, b) => b.total - a.total);
    return { total: list.reduce((sum, c) => sum + c.total, 0), categories: list };
  }
}

/** Strict non-negative integer query parameter; malformed values are a 400, not a database error. */
function intParam(raw: string | undefined, fallback: number, min: number, max: number, name: string): number {
  if (raw === undefined || raw === '') return fallback;
  if (!/^[0-9]{1,7}$/.test(raw)) throw new ApiError(400, 'VALIDATION_FAILED', `${name} must be an integer`);
  return Math.min(Math.max(Number(raw), min), max);
}
