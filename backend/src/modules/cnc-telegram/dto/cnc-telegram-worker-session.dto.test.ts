import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../common/errors/api-error';
import {
  parseWorkerSessionHeartbeat,
  parseWorkerSessionLease,
  parseWorkerSessionLeaseHeaders,
} from './cnc-telegram-worker-session.dto';

const workerInstanceId = '550e8400-e29b-41d4-a716-446655440000';

describe('CNC Telegram worker session DTOs', () => {
  it('accepts only the strict claim contract used by the worker', () => {
    expect(parseWorkerSessionLease({
      chatId: '-100123', workerInstanceId, imageRevision: 'd0e683b40744',
    })).toEqual({
      sourceChatId: '-100123', workerInstanceId, workerImageRevision: 'd0e683b40744',
    });
    expect(() => parseWorkerSessionLease({
      chatId: '-100123', workerInstanceId, imageRevision: 'd0e683b40744', extra: true,
    })).toThrow(ApiError);
    expect(() => parseWorkerSessionLease({
      sourceChatId: '-100123', workerInstanceId, imageRevision: 'd0e683b40744',
    })).toThrow(ApiError);
    expect(() => parseWorkerSessionLease({
      chatId: '-100123', workerInstanceId, imageRevision: 'unknown',
    })).toThrow(ApiError);
  });

  it('accepts and maps worker runtime evidence for audit diagnostics', () => {
    expect(parseWorkerSessionLease({
      chatId: '-100123',
      workerInstanceId,
      imageRevision: 'd0e683b40744',
      runtime: {
        stackEnv: 'prod',
        workerRole: 'writer',
        canSendManualSvgUploads: true,
        manualSvgSendPollIntervalSeconds: 5,
        parserVersion: '2026-08-24',
      },
    })).toMatchObject({
      runtimeEvidence: {
        stackEnv: 'prod',
        workerRole: 'writer',
        canSendManualSvgUploads: true,
        manualSvgSendPollIntervalSeconds: 5,
        parserVersion: '2026-08-24',
      },
    });
  });

  it.each([
    { manualSvgSendPollIntervalSeconds: 0 },
    { workerRole: 'admin' },
    { extra: true },
  ])('rejects invalid or non-strict runtime evidence: %o', (runtimeOverride) => {
    expect(() => parseWorkerSessionLease({
      chatId: '-100123',
      workerInstanceId,
      imageRevision: 'd0e683b40744',
      runtime: {
        stackEnv: 'prod',
        workerRole: 'writer',
        canSendManualSvgUploads: true,
        manualSvgSendPollIntervalSeconds: 5,
        parserVersion: '2026-08-24',
        ...runtimeOverride,
      },
    })).toThrow(ApiError);
  });

  it('keeps heartbeat body strict and fences headers to a UUID worker instance', () => {
    expect(parseWorkerSessionHeartbeat({ workerInstanceId })).toEqual({ workerInstanceId });
    expect(() => parseWorkerSessionHeartbeat({ workerInstanceId, sourceChatId: '-100123' })).toThrow(ApiError);
    expect(parseWorkerSessionLeaseHeaders('t'.repeat(64), '2', undefined, workerInstanceId))
      .toMatchObject({ sourceChatId: '', leaseGeneration: 2, workerInstanceId });
    expect(() => parseWorkerSessionLeaseHeaders('t'.repeat(64), '2', undefined, undefined)).toThrow(ApiError);
  });
});
