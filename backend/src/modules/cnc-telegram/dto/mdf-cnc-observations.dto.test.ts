import { describe, expect, it } from 'vitest';
import {
  parseMdfCncObservationClaimId,
  parseMdfCncObservationFailure,
  parseMdfCncObservationReport,
} from './mdf-cnc-observations.dto';

const claimId = '0d7080d2-6d9d-4f38-9628-23f9e92b0b11';
const token = 'a'.repeat(64);
const workerGroup = [
  { messageId: 10, chatId: '-100123', role: 'svg', sha256: 'a'.repeat(64), present: true, thumbsUp: false },
  { messageId: 11, chatId: '-100123', role: 'gcode', sha256: 'b'.repeat(64), present: true, thumbsUp: true },
  { messageId: 12, chatId: '-100123', role: 'image', sha256: 'c'.repeat(64), present: true, thumbsUp: false },
] as const;

describe('MDF CNC observation DTOs', () => {
  it('accepts only exact server claim identity and complete bounded group facts', () => {
    expect(parseMdfCncObservationClaimId(claimId)).toBe(claimId);
    expect(parseMdfCncObservationReport({
      claimId,
      claimToken: token,
      claimGeneration: 2,
      messages: workerGroup,
    })).toMatchObject({ claimId, claimGeneration: 2, messages: [{ role: 'svg' }, { role: 'gcode' }, { role: 'image' }] });
  });

  it.each([
    ['target takeover', { targetPacketId: 'other-packet' }],
    ['client source version', { sourceVersion: 9000 }],
    ['client timestamp', { observedAt: '2026-09-23T12:00:00Z' }],
    ['client completion classification', { completionStatus: 'completed' }],
  ])('rejects %s fields instead of accepting client authority', (_label, extra) => {
    expect(() => parseMdfCncObservationReport({
      claimId,
      claimToken: token,
      claimGeneration: 2,
      messages: workerGroup,
      ...extra,
    })).toThrowError(expect.objectContaining({ code: 'VALIDATION_ERROR', statusCode: 422 }));
  });

  it('leaves claim-specific chat binding to the repository', () => {
    expect(parseMdfCncObservationReport({ claimId, claimToken: token, claimGeneration: 2,
      messages: [{ ...workerGroup[0], chatId: 'other-chat' }] })).toMatchObject({
      messages: [{ chatId: 'other-chat' }],
    });
  });

  it('rejects malformed message facts; server-side exact-claim validation handles a truncated otherwise-valid list', () => {
    for (const messages of [
      [],
      [{ ...workerGroup[0], present: false }],
      [{ ...workerGroup[0], sha256: 'bad' }],
      [{ ...workerGroup[0] }, { ...workerGroup[0], messageId: 10, role: 'image' }],
      [{ ...workerGroup[0] }, { ...workerGroup[1], role: 'svg' }],
    ]) {
      expect(() => parseMdfCncObservationReport({ claimId, claimToken: token, claimGeneration: 2, messages }))
        .toThrowError(expect.objectContaining({ code: 'VALIDATION_ERROR', statusCode: 422 }));
    }
    expect(parseMdfCncObservationReport({ claimId, claimToken: token, claimGeneration: 2,
      messages: workerGroup.slice(0, 2) })).toMatchObject({ messages: [{ messageId: 10 }, { messageId: 11 }] });
  });

  it('accepts only bounded failure reasons bound to a claim token and generation', () => {
    expect(parseMdfCncObservationFailure({
      claimToken: token,
      claimGeneration: 3,
      reason: 'MESSAGE_MISSING',
    })).toEqual({ claimToken: token, claimGeneration: 3, reason: 'MESSAGE_MISSING' });
    expect(() => parseMdfCncObservationFailure({
      claimToken: token,
      claimGeneration: 3,
      reason: 'HISTORY_SCAN_FAILED',
      sourceVersion: 200,
    })).toThrowError(expect.objectContaining({ code: 'VALIDATION_ERROR', statusCode: 422 }));
  });
});
