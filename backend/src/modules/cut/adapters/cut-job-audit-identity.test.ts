import { describe, expect, it, vi } from 'vitest';
import type { DatabaseClient } from '../../../database/database.types';
import { loadCutJobAuditIdentities } from './cut-job-audit-identity';

describe('cut audit identity', () => {
  it('keeps display numbers distinct from IDs, including reused and legacy vacuum numbers', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [
      { cut_job_id: '91', name: 'Тест старый', source_display_number: '7', uses_vacuum: true },
      { cut_job_id: '92', name: 'Тест новый', source_display_number: '7' },
      { cut_job_id: '93', name: 'Тест ванны', source_display_number: 'В-8', uses_vacuum: true },
      { cut_job_id: '94', name: 'Тест legacy', source_display_number: null, uses_vacuum: true },
    ] });
    const client: DatabaseClient = { query };
    const identities = await loadCutJobAuditIdentities(client, [91, 92, 93, 94, 91]);
    expect([...identities.values()].map((value) => value.cutJobDisplayNumber)).toEqual(['7', '7', 'В-8', 'В-94']);
    expect(identities.get(91)?.cutJobName).toBe('Тест старый');
    expect(identities.get(92)?.cutJobName).toBe('Тест новый');
    expect(query.mock.calls[0][1]).toEqual([[91, 92, 93, 94]]);
    expect(query.mock.calls[0][0]).not.toContain("status <> 'archived'");
  });

  it('does not query an empty ID list and does not invent a missing record', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const client: DatabaseClient = { query };
    expect((await loadCutJobAuditIdentities(client, [])).size).toBe(0);
    expect(query).not.toHaveBeenCalled();
    expect((await loadCutJobAuditIdentities(client, [91])).has(91)).toBe(false);
  });
});
