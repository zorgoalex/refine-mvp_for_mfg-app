import { describe, expect, it } from 'vitest';
import { originState, readBackOrigin } from './backToOrigin';

describe('back to origin', () => {
  it('remembers the screen a card was opened from', () => {
    expect(originState({ pathname: '/orders/show/12', search: '?tab=details' }, 'Заказ 3087'))
      .toEqual({ from: '/orders/show/12?tab=details', fromLabel: 'Заказ 3087' });
    expect(originState({ pathname: '/calendar' })).toEqual({ from: '/calendar' });
  });

  it('reads only an in-app path back', () => {
    expect(readBackOrigin({ from: '/orders/show/12', fromLabel: 'Заказ 3087' })).toEqual({ from: '/orders/show/12', fromLabel: 'Заказ 3087' });
    expect(readBackOrigin({ from: 'https://evil.example' })).toBeNull();
    expect(readBackOrigin({ from: 42 })).toBeNull();
    expect(readBackOrigin(null)).toBeNull();
  });
});
