import { describe, expect, it } from 'vitest';
import { assignOrderLifecycleCohort, isUsableOrderLifecycleConfig } from './orderLifecycleRollout';

const config = {
  enabled: true,
  percent: 25,
  allocationSalt: 'salt-v1',
  configVersion: 'lifecycle-v1',
};

describe('order lifecycle rollout assignment', () => {
  it('fails closed for absent or invalid config and subject', async () => {
    expect(await assignOrderLifecycleCohort(undefined, '7')).toBe('disabled');
    expect(await assignOrderLifecycleCohort(config, null)).toBe('disabled');
    expect(isUsableOrderLifecycleConfig({ ...config, allocationSalt: '' })).toBe(false);
  });

  it('uses subject only inside deterministic hash input', async () => {
    const inputs: string[] = [];
    const digest = async (value: string) => {
      inputs.push(value);
      return new Uint8Array([0, 0, 0, 0]);
    };

    expect(await assignOrderLifecycleCohort(config, 'user-42', digest)).toBe('treatment');
    expect(inputs).toEqual(['orderLifecycleV2:salt-v1:user-42']);
  });

  it('keeps remaining eligible buckets in same-build control', async () => {
    const digest = async () => new Uint8Array([255, 255, 255, 255]);
    expect(await assignOrderLifecycleCohort(config, 'user-42', digest)).toBe('control');
  });
});
