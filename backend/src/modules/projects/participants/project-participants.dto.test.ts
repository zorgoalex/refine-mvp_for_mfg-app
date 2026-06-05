import { describe, expect, it } from 'vitest';

import {
  PROJECT_PARTICIPANT_ROLE_CODES,
  PROJECT_PARTICIPANT_TYPES,
  parseReplaceProjectParticipantsRequest,
} from './project-participants.dto';

describe('project participant DTO parsing', () => {
  it('accepts user and employee participants', () => {
    expect(parseReplaceProjectParticipantsRequest({
      idempotencyKey: 'key-1',
      participants: [
        { participantType: 'user', participantId: '158', roleCode: 'manager', metadata: {} },
        { participantType: 'employee', participantId: '77', roleCode: 'observer', metadata: {} },
      ],
      reason: 'test',
    }).participants).toEqual([
      { participantType: 'user', participantId: '158', roleCode: 'manager', metadata: {} },
      { participantType: 'employee', participantId: '77', roleCode: 'observer', metadata: {} },
    ]);
  });

  it('normalizes defaults and trimmed string fields', () => {
    expect(parseReplaceProjectParticipantsRequest({
      idempotencyKey: ' key-1 ',
      participants: [{ participantType: 'user', participantId: '  158  ', roleCode: ' manager ' }],
      reason: ' reason ',
    })).toEqual({
      idempotencyKey: 'key-1',
      participants: [{
        participantType: 'user',
        participantId: '158',
        roleCode: 'manager',
        metadata: {},
      }],
      reason: 'reason',
    });
  });

  it('exports only accepted participant types and seeded role constants', () => {
    expect([...PROJECT_PARTICIPANT_TYPES]).toEqual(['user', 'employee']);
    expect([...PROJECT_PARTICIPANT_ROLE_CODES]).toEqual([
      'owner',
      'manager',
      'participant',
      'observer',
    ]);
  });

  it('rejects duplicate typed participants regardless of role', () => {
    expect(() => parseReplaceProjectParticipantsRequest({
      idempotencyKey: 'key-1',
      participants: [
        { participantType: 'user', participantId: '158', roleCode: 'manager' },
        { participantType: 'user', participantId: '158', roleCode: 'observer' },
      ],
    })).toThrow(/Duplicate/);
  });

  it('rejects arbitrary participant types, invalid role codes, blank ids, and oversized lists', () => {
    expect(() => parseReplaceProjectParticipantsRequest({
      idempotencyKey: 'key-1',
      participants: [{ participantType: 'client', participantId: '42', roleCode: 'manager' }],
    })).toThrow(/VALIDATION_ERROR/);
    expect(() => parseReplaceProjectParticipantsRequest({
      idempotencyKey: 'key-1',
      participants: [{ participantType: 'user', participantId: '42', roleCode: 'bad-value' }],
    })).toThrow(/VALIDATION_ERROR/);
    expect(() => parseReplaceProjectParticipantsRequest({
      idempotencyKey: 'key-1',
      participants: [{ participantType: 'user', participantId: ' ', roleCode: 'manager' }],
    })).toThrow(/VALIDATION_ERROR/);
    expect(() => parseReplaceProjectParticipantsRequest({
      idempotencyKey: 'key-1',
      participants: Array.from({ length: 501 }, (_, index) => ({
        participantType: 'user',
        participantId: String(index),
        roleCode: 'manager',
      })),
    })).toThrow(/VALIDATION_ERROR/);
  });
});
