import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ONEC_ALERT_GROUPS,
  ONEC_ALERT_GROUP_CODES,
  ONEC_ALERT_KINDS,
  buildOnecAlertText,
  effectiveImportance,
  formatAlmaty,
  isValidQuietHours,
  levelForImportance,
  maxImportance,
  onecAlertGroupOf,
  type OnecAlertMemberView,
} from './onec-alert-groups';

const SRC = resolve(__dirname, '../../..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.ts$/.test(name) && !/\.(test|spec)\.ts$|\.integration\.test\.ts$/.test(name) ? [path] : [];
  });
}

/** Kinds raised in the code: literals in upsertAlert/raise calls and *_ALERT_KIND constants. */
function raisedKinds(): Set<string> {
  const kinds = new Set<string>();
  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, 'utf8');
    for (const call of text.matchAll(/(?:upsertAlert|\.raise)\(\s*\w+,\s*\{([\s\S]*?)\}\s*\)/g)) {
      const literal = /kind:\s*'([a-z][a-z0-9_.]*)'/.exec(call[1]);
      if (literal) kinds.add(literal[1]);
    }
    for (const constant of text.matchAll(/[A-Z_]*ALERT_KIND\s*=\s*'([a-z][a-z0-9_.]*)'/g)) kinds.add(constant[1]);
  }
  return kinds;
}

describe('1C alert groups (plan 2026-10-19 §2.3)', () => {
  it('lists every alert kind the code raises (an unlisted kind would silently fall into «other»)', () => {
    const raised = raisedKinds();
    expect(raised.size).toBeGreaterThanOrEqual(15);
    expect([...raised].filter((kind) => !(kind in ONEC_ALERT_KINDS)).sort()).toEqual([]);
  });

  it('maps kinds to the planned groups; unknown kinds go to «other»', () => {
    expect(onecAlertGroupOf('agent_silent')).toBe('agent_offline');
    expect(onecAlertGroupOf('agent_state')).toBe('agent_state');
    expect(onecAlertGroupOf('etl_entity_failed')).toBe('sync');
    expect(onecAlertGroupOf('onec_nightly_full_sync_missed')).toBe('sync');
    expect(onecAlertGroupOf('command_expired_undelivered')).toBe('commands');
    expect(onecAlertGroupOf('source_identity_changed')).toBe('config_source');
    expect(onecAlertGroupOf('certificate_expiring')).toBe('certificate');
    expect(onecAlertGroupOf('onec_stock_snapshot_slot_stuck')).toBe('stock_snapshots');
    expect(onecAlertGroupOf('some_future_kind')).toBe('other');
    expect(ONEC_ALERT_GROUPS.map((group) => group.code)).toEqual([...ONEC_ALERT_GROUP_CODES]);
  });

  it('derives importance and level', () => {
    expect(effectiveImportance('auto', 'critical')).toBe('critical');
    expect(effectiveImportance('auto', 'warning')).toBe('important');
    expect(effectiveImportance('auto', 'info')).toBe('info');
    expect(effectiveImportance('important', 'critical')).toBe('important');
    expect(maxImportance(['info', 'critical', 'important'])).toBe('critical');
    expect(levelForImportance('critical')).toBe('error');
    expect(levelForImportance('important')).toBe('warning');
    expect(levelForImportance('info')).toBe('info');
  });

  it('validates quiet hours, crossing midnight allowed', () => {
    expect(isValidQuietHours('23:00-08:00')).toBe(true);
    expect(isValidQuietHours('08:00-08:00')).toBe(false);
    expect(isValidQuietHours('24:00-08:00')).toBe(false);
    expect(isValidQuietHours('8:00-9:00')).toBe(false);
  });

  it('writes Almaty times and only white-listed details', () => {
    const member = (kind: string, details: Record<string, unknown> = {}): OnecAlertMemberView => ({
      kind,
      severity: 'critical',
      agentId: 'unf-kz-prod-01',
      sourceName: null,
      openedAt: new Date('2026-10-16T23:50:00Z'),
      resolvedAt: null,
      details,
    });
    expect(formatAlmaty(new Date('2026-10-16T23:50:00Z'))).toBe('17.10 04:50');
    const single = buildOnecAlertText({ stage: 'opened', group: 'agent_offline', importance: 'critical', members: [member('agent_silent', { lastError: 'secret path' })] });
    expect(single.title).toBe('1С — Агент молчит');
    expect(single.message).toContain('• Агент молчит — unf-kz-prod-01, с 17.10 04:50');
    expect(single.message).toContain('Важность: Критично.');
    expect(single.message).not.toContain('secret');
    const state = buildOnecAlertText({ stage: 'reminder', group: 'agent_state', importance: 'critical', members: [member('agent_state', { state: 'stopped' })] });
    expect(state.title).toBe('1С — Напоминание: Состояние агента');
    expect(state.message).toContain('Состояние агента (stopped)');
    const many = buildOnecAlertText({
      stage: 'opened',
      group: 'sync',
      importance: 'important',
      members: Array.from({ length: 12 }, () => member('etl_entity_failed')),
    });
    expect(many.title).toBe('1С — Выгрузка данных: 12');
    expect(many.message).toContain('…и ещё 2.');
  });
});
