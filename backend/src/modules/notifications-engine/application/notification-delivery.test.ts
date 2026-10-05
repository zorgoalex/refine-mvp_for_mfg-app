import { describe, expect, it } from 'vitest';
import { balloonFor } from './notification-delivery';

describe('balloonFor — the single balloon decision', () => {
  it('balloon only with in_app + balloon channels; mode from the rule; no rule → none', () => {
    expect(balloonFor({ channels: ['in_app', 'balloon'], balloonMode: 'persistent' })).toBe('persistent');
    expect(balloonFor({ channels: ['in_app', 'balloon', 'telegram'], balloonMode: 'auto' })).toBe('auto');
    expect(balloonFor({ channels: ['in_app'], balloonMode: 'persistent' })).toBeNull();
    expect(balloonFor({ channels: ['balloon'], balloonMode: 'auto' })).toBeNull();
    expect(balloonFor(null)).toBeNull();
  });
});
