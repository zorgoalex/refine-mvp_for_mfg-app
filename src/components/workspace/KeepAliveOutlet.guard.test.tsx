import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

const outlet = readFileSync(resolve(__dirname, 'KeepAliveOutlet.tsx'), 'utf8');
const policy = readFileSync(resolve(__dirname, 'keepAlive.ts'), 'utf8');

describe('KeepAliveOutlet guards', () => {
  it('renders cached tabs in <div hidden=...> keyed off active', () => {
    expect(outlet).toContain('hidden={key !== activeKey}');
  });
  it('exposes isActive via KeepAliveContext', () => {
    expect(outlet).toContain('KeepAliveContext.Provider');
    expect(outlet).toContain('isActive');
  });
  it('excludes /calendar from keep-alive (B7)', () => {
    expect(policy).toContain("'/calendar'");
  });
  it('adds no new keep-alive dependency (hand-rolled over useOutlet)', () => {
    expect(outlet).toContain('useOutlet');
    expect(outlet).not.toContain('react-activation');
  });
});
