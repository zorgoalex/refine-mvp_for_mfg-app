import { describe, expect, it } from 'vitest';
import { resolveMdfBoardRenderMode, selectMdfBoardMode, type MdfEngineModeFetchResult } from './mdfBoardMode';

const ok = (mode: 'legacy' | 'shadow' | 'active' | 'read_only', publishedReads = true): MdfEngineModeFetchResult => (
  { kind: 'ok', engineMode: { mode, publishedReads } }
);

describe('selectMdfBoardMode', () => {
  it('renders legacy for legacy/shadow engine mode', () => {
    expect(selectMdfBoardMode({ engineModeFetch: ok('legacy'), publishedReadsFailed: false })).toBe('legacy');
    expect(selectMdfBoardMode({ engineModeFetch: ok('shadow'), publishedReadsFailed: false })).toBe('legacy');
  });

  it('renders published for active/read_only with working published reads', () => {
    expect(selectMdfBoardMode({ engineModeFetch: ok('active'), publishedReadsFailed: false })).toBe('published');
    expect(selectMdfBoardMode({ engineModeFetch: ok('read_only'), publishedReadsFailed: false })).toBe('published');
  });

  it('never falls back to legacy when active/read_only and reads are off or fail', () => {
    expect(selectMdfBoardMode({ engineModeFetch: ok('active', false), publishedReadsFailed: false })).toBe('unavailable');
    expect(selectMdfBoardMode({ engineModeFetch: ok('read_only', false), publishedReadsFailed: false })).toBe('unavailable');
    expect(selectMdfBoardMode({ engineModeFetch: ok('active'), publishedReadsFailed: true })).toBe('unavailable');
    expect(selectMdfBoardMode({ engineModeFetch: ok('read_only'), publishedReadsFailed: true })).toBe('unavailable');
  });

  it('treats a 404 (backend without the endpoint) as legacy', () => {
    expect(selectMdfBoardMode({ engineModeFetch: { kind: 'endpointMissing' }, publishedReadsFailed: false })).toBe('legacy');
  });

  it('treats any other engine-mode fetch failure as unavailable, never legacy', () => {
    expect(selectMdfBoardMode({ engineModeFetch: { kind: 'error' }, publishedReadsFailed: false })).toBe('unavailable');
  });

  it('treats an unrecognized mode string defensively as unavailable', () => {
    expect(selectMdfBoardMode({
      engineModeFetch: { kind: 'ok', engineMode: { mode: 'weird' as never, publishedReads: true } },
      publishedReadsFailed: false,
    })).toBe('unavailable');
  });
});

describe('resolveMdfBoardRenderMode (§5.6 finding 5)', () => {
  it('renders loading while mode has not resolved yet (mode null), regardless of session', () => {
    expect(resolveMdfBoardRenderMode({ mode: null, hasSession: false })).toBe('loading');
    expect(resolveMdfBoardRenderMode({ mode: null, hasSession: true })).toBe('loading');
  });

  it('never falls through to legacy while mode is null — even across repeated/delayed calls', () => {
    for (let i = 0; i < 5; i += 1) {
      expect(resolveMdfBoardRenderMode({ mode: null, hasSession: false })).not.toBe('legacy');
    }
  });

  it('renders unavailable for the explicit unavailable mode', () => {
    expect(resolveMdfBoardRenderMode({ mode: 'unavailable', hasSession: false })).toBe('unavailable');
  });

  it('renders published only once a session is loaded; defensively loading otherwise', () => {
    expect(resolveMdfBoardRenderMode({ mode: 'published', hasSession: true })).toBe('published');
    expect(resolveMdfBoardRenderMode({ mode: 'published', hasSession: false })).toBe('loading');
  });

  it('renders legacy ONLY for the explicit legacy mode result', () => {
    expect(resolveMdfBoardRenderMode({ mode: 'legacy', hasSession: false })).toBe('legacy');
  });
});
