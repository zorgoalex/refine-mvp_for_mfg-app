import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const tab = readFileSync(new URL('./AccessGroupsTab.tsx', import.meta.url), 'utf8');
const card = readFileSync(new URL('../../users/UserAccessGroupsCard.tsx', import.meta.url), 'utf8');
const edit = readFileSync(new URL('../../users/edit.tsx', import.meta.url), 'utf8');

describe('access groups UI wiring (no jsdom: source guards next to the model tests)', () => {
  it('every group command reconciles only its own section', () => {
    for (const section of ['meta', 'active', 'permissions', 'members']) expect(tab).toContain(`apply(next, '${section}')`);
    expect(tab).not.toMatch(/apply\(next\)/);
    // the activity switch sends only the activity
    expect(tab).toContain('const request = { version: group!.version, isActive };');
  });

  it('loads the groups without the user lookup and the lookup only with users.view', () => {
    expect(tab).toContain("Promise.all([accessGroupsApi.list(), permissionsMatrixApi.get()])");
    expect(tab).toContain("if (can('users.view'))");
  });

  it('one group command at a time, its conflict reload awaited inside the lock; reads through readLatest', () => {
    expect(tab).toContain('await commands.run(async () => {');
    expect(tab).toContain("if (isStaleConflict(error)) await reload('conflict');");
    expect(tab).toContain('draftsAfterConflict(base, next, draftsRef.current)');
    expect(tab).toContain('readLatest(reads, () => accessGroupsApi.get(groupId)');
    expect(tab.match(/\|\| busy/g)?.length ?? 0).toBeGreaterThanOrEqual(8);
  });

  it('«Обновить» re-reads the open group, merged with its unsaved edits', () => {
    expect(tab).toContain('refreshSignal={refreshSignal}');
    expect(tab).toContain("void reload('conflict');");
  });

  it('the switch: one command at a time, earlier list reads invalidated, locked while loading', () => {
    expect(tab).toContain('onOk: () => switchLock.run(async () => {');
    expect(tab).toContain('listReads.begin();');
    expect(tab).toContain('disabled={loading || switching}');
  });

  it('the user card belongs to one user and drops reads overtaken by a save', () => {
    expect(edit).toContain('key={String(userId)}');
    // R5: every answer advances the form version only for the user it was sent for
    expect(edit).toContain('if (String(shownUserId.current) !== String(requestUserId)) return;');
    expect(edit.match(/advanceFor\(requestUserId/g)?.length).toBe(2);
    expect(edit.match(/setOwnRowVersion\(\(own\) => advanceOwnVersion/g)?.length).toBe(1);
    expect(card).toContain('if (!alive.current || next.userId !== userId) return;');
    expect(card).toContain('if (!generations.isCurrent(generation)) return;');
    expect(card).toContain('disabled={!editable || saving || loading}');
    expect(card).toContain('`${groupId}:${versions.get(groupId)');
    // R4/R6: the choice is merged against the groups it was made from, outside any updater
    expect(card).toContain('userGroupsAfterReload(selectedRef.current, savedGroups.current, saved)');
    // R6: the card sends the version read with its own groups, never the user form's version
    expect(card).toContain('const rowVersion = authorization.rowVersion;');
    expect(card).not.toContain('currentVersion');
    expect(edit).not.toContain('currentVersion={currentVersion}');
    // R4: StrictMode replays effects — the setup sets the flag again
    expect(card).toMatch(/useEffect\(\(\) => \{\s*\/\/[^\n]*\n\s*alive\.current = true;/);
  });

  it('the user card reads the rights again after the user form saved the user', () => {
    expect(edit).toContain('reloadKey={authorizationReload}');
    expect(edit.match(/setAuthorizationReload\(\(value\) => value \+ 1\)/g)?.length).toBe(2);
    expect(card).toContain('[coordinator, load, reloadKey]');
    // R7: reloads during a save are queued behind it; a conflict reload too
    expect(card).toContain('await coordinator.save(async () => {');
    expect(card).toContain('if (isStaleConflict(error)) coordinator.reload(() => void load());');
    // R7: the form advances only for a group command sent from its own baseline
    expect(edit).toContain('if (sent === currentVersion()) advanceFor(userId, sent, returned);');
  });
});
