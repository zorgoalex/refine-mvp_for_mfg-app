import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

/** Transitional users command protocol (access groups plan §5.3) in the user forms. */
describe('user forms: one key per action and the current row version', () => {
  it('the edit form repeats the key of an unfinished save and keeps the version from its own commands', () => {
    const edit = read('./edit.tsx');
    expect(edit).toContain('usersApi.update(Number(requestUserId), request, key)');
    expect(edit).toContain('usersApi.changePassword(Number(requestUserId), request, key)');
    // The success confirms exactly its own key; the version advances only through advanceOwnVersion (sent + 1) and
    // only for the user the command was sent for (the route may show another user by then).
    expect(edit).toMatch(/saveKeys\.succeeded\(key\);\s*advanceFor\(requestUserId, expectedVersion, response\.user\.rowVersion\)/);
    expect(edit).toMatch(/passwordKeys\.succeeded\(key\);\s*advanceFor\(requestUserId, expectedVersion, response\.rowVersion\)/);
    expect(edit).toMatch(/if \(String\(shownUserId\.current\) !== String\(requestUserId\)\) return;\s*setOwnRowVersion\(\(own\) => advanceOwnVersion\(own, sent, returned\)\)/);
    // The password change carries the form version too (it must not mask another administrator's change).
    expect(edit).toMatch(/newPassword: values\.new_password,[\s\S]*expectedVersion/);
    // No reload after save: it would drop fields being edited.
    expect(edit).not.toContain('queryResult?.refetch()');
  });

  it('the create form repeats the key of an unfinished create', () => {
    const create = read('./create.tsx');
    expect(create).toContain('usersApi.create(request, key)');
    expect(create).toMatch(/createKeys\.succeeded\(key\)/);
  });
});
