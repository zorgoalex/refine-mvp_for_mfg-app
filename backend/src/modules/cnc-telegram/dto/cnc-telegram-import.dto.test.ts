import { describe, expect, it } from 'vitest';
import { parseImportCandidateBatch } from './cnc-telegram-import.dto';

const lease = {
  itemLeaseToken: 'l'.repeat(32),
  itemLeaseGeneration: 1,
  itemLeaseOwner: '00000000-0000-4000-8000-000000000001',
};

const message = {
  sourceChatId: '-100123',
  sourceMessageId: '9007199254740993',
  sourceThreadId: '9007199254740994',
  replyToMessageId: null,
  senderUserId: '9007199254740995',
  sourceCreatedAt: '2026-08-19T10:00:00+00:00',
  workday: '2026-08-19',
  messageType: 'image' as const,
  filename: null,
  mimeType: 'image/jpeg',
  messageText: 'Раскрой',
  outgoing: false,
  candidateSourceMessageId: '9007199254740993',
  candidateRole: 'screenshot' as const,
  readOrdinal: 1,
};

describe('Telegram import message DTO', () => {
  it('preserves large Telegram ids as canonical strings at the HTTP boundary', () => {
    const parsed = parseImportCandidateBatch({ ...lease, candidates: [], messages: [message] });

    expect(parsed.messages[0]).toMatchObject({
      sourceMessageId: '9007199254740993',
      sourceThreadId: '9007199254740994',
      senderUserId: '9007199254740995',
      candidateSourceMessageId: '9007199254740993',
    });
  });

  it('accepts legacy safe numeric ids but rejects unsafe JSON numbers', () => {
    const legacy = parseImportCandidateBatch({
      ...lease,
      candidates: [],
      messages: [{ ...message, sourceMessageId: 42, sourceThreadId: 7, candidateSourceMessageId: 42 }],
    });
    expect(legacy.messages[0]?.sourceMessageId).toBe('42');

    expect(() => parseImportCandidateBatch({
      ...lease,
      candidates: [],
      messages: [{ ...message, sourceMessageId: Number.MAX_SAFE_INTEGER + 2 }],
    })).toThrow(/Invalid candidate batch/);
  });

  it('requires candidate links to carry both the source id and role', () => {
    expect(() => parseImportCandidateBatch({
      ...lease,
      candidates: [],
      messages: [{ ...message, candidateRole: null }],
    })).toThrow(/Invalid candidate batch/);
  });

  it('preserves candidate Telegram ids as decimal strings', () => {
    const candidate = {
      sourceChatId: '-100123',
      sourceMessageId: '9007199254740993',
      sourceThreadId: '9007199254740994',
      workday: '2026-08-19',
      svgMessageId: '9007199254740993',
      gcodeMessageId: '9007199254740995',
      screenshotMessageId: '9007199254740996',
      svgFileName: 'layout.svg',
      gcodeFileName: 'layout.nc',
      screenshotFileName: null,
      svgContentSha256: 'a'.repeat(64),
      gcodeContentSha256: 'b'.repeat(64),
      screenshotContentSha256: 'c'.repeat(64),
      sourceSetFingerprint: 'd'.repeat(64),
      parserVersion: 'v1',
      parsedSnapshot: {},
      cutLayout: null,
      warnings: [],
      eligibilityStatus: 'valid' as const,
    };

    const parsed = parseImportCandidateBatch({ ...lease, candidates: [candidate], messages: [] });

    expect(parsed.candidates[0]).toMatchObject({
      sourceMessageId: '9007199254740993',
      sourceThreadId: '9007199254740994',
      svgMessageId: '9007199254740993',
      gcodeMessageId: '9007199254740995',
      screenshotMessageId: '9007199254740996',
    });
  });

  it('accepts at most the global 5000-message scan bound in one atomic batch', () => {
    expect(() => parseImportCandidateBatch({ ...lease, candidates: [], messages: Array.from({ length: 5001 }, () => message) }))
      .toThrow(/Invalid candidate batch/);
  });
});
