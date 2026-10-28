import { describe, expect, it, vi } from 'vitest';
import { setTorch, torchSupported } from './cameraTorch';

const track = (capabilities: unknown, extra: Record<string, unknown> = {}) => ({
  applyConstraints: vi.fn().mockResolvedValue(undefined),
  getCapabilities: () => capabilities as MediaTrackCapabilities,
  readyState: 'live' as MediaStreamTrackState,
  ...extra,
});

describe('camera torch', () => {
  it('is offered only when the live camera declares torch', () => {
    expect(torchSupported(track({ torch: true }))).toBe(true);
    expect(torchSupported(track({}))).toBe(false);
    expect(torchSupported(track({ torch: true }, { readyState: 'ended' }))).toBe(false);
    expect(torchSupported(track({ torch: true }, { getCapabilities: undefined }))).toBe(false);
    expect(torchSupported(track({ torch: true }, { getCapabilities: () => { throw new Error('x'); } }))).toBe(false);
    expect(torchSupported(null)).toBe(false);
  });

  it('switches through an advanced constraint and reports a refusal', async () => {
    const ok = track({ torch: true });
    expect(await setTorch(ok, true)).toBe(true);
    expect(ok.applyConstraints).toHaveBeenCalledWith({ advanced: [{ torch: true }] });
    const refused = track({ torch: true }, { applyConstraints: vi.fn().mockRejectedValue(new Error('busy')) });
    expect(await setTorch(refused, false)).toBe(false);
  });
});
