import { describe, expect, it } from 'vitest';
import { advanceOwnVersion, formRowVersion } from './userFormVersion';
import { createActionKeyStore } from '../../api/actionIdempotency';

describe('row version of an open user form', () => {
  it('a password change does not hide another administrator\'s profile change (R3 #1)', () => {
    // Loaded with v1. Another administrator saves the profile → v2 (unknown to this form).
    let own: number | undefined;
    const sent = formRowVersion(1, own); // the password change is sent with expectedVersion 1 → server answers 409
    expect(sent).toBe(1);
    // Had an old backend ignored the version and answered v3, the form must not adopt it.
    own = advanceOwnVersion(own, undefined, 3);
    expect(formRowVersion(1, own)).toBe(1); // the next save still conflicts instead of overwriting v2
  });

  it('own confirmed commands advance the version; a late older response never lowers it (R3 #3)', () => {
    let own: number | undefined;
    own = advanceOwnVersion(own, 1, 2); // password change confirmed on v1
    expect(formRowVersion(1, own)).toBe(2);
    own = advanceOwnVersion(own, 2, 3); // save B confirmed on v2
    own = advanceOwnVersion(own, 1, 2); // late response of the first command
    expect(formRowVersion(1, own)).toBe(3);
    // A response that is not exactly sent + 1 (the row moved meanwhile) is not adopted.
    expect(advanceOwnVersion(3, 3, 6)).toBe(3);
  });

  it('a late confirmation of action A does not clear the key of the unconfirmed action B (R3 #3)', () => {
    let n = 0;
    const keys = createActionKeyStore(() => `k-${++n}`);
    const keyA = keys.keyFor({ fullName: 'A' });
    keys.succeeded(keyA);
    const keyB = keys.keyFor({ fullName: 'B' });
    keys.succeeded(keyA); // late duplicate response of A
    expect(keys.keyFor({ fullName: 'B' })).toBe(keyB); // B is repeated with its own key
  });
});
