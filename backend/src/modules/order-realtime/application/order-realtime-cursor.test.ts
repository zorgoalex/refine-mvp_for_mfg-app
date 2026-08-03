import { describe, expect, it } from 'vitest';
import { formatOrderRealtimeCursor, parseOrderRealtimeCursor } from './order-realtime-cursor';

describe('order realtime cursor', () => {
  it('round-trips the permission-projected variants', () => {
    expect(parseOrderRealtimeCursor('v1;s=12', { cutRefsAllowed: false })).toEqual({
      schemaVersion: 1,
      detailStatusRevision: 12,
    });
    expect(parseOrderRealtimeCursor('v1;s=12;c=7', { cutRefsAllowed: true })).toEqual({
      schemaVersion: 1,
      detailStatusRevision: 12,
      cutRefsRevision: 7,
    });
    expect(formatOrderRealtimeCursor({ schemaVersion: 1, detailStatusRevision: 12 })).toBe('v1;s=12');
  });

  it('rejects forbidden or missing domain components', () => {
    expect(() => parseOrderRealtimeCursor('v1;s=1;c=2', { cutRefsAllowed: false })).toThrow();
    expect(() => parseOrderRealtimeCursor('v1;s=1', { cutRefsAllowed: true })).toThrow();
    expect(() => parseOrderRealtimeCursor('v2;s=1', { cutRefsAllowed: false })).toThrow();
  });
});
