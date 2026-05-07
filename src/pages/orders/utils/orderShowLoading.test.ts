import { describe, expect, it } from 'vitest';
import { shouldShowOrderLoading } from './orderShowLoading';

describe('shouldShowOrderLoading', () => {
  it('does not keep backend-read order show blurred because legacy details query is disabled', () => {
    expect(
      shouldShowOrderLoading({
        orderLoading: false,
        detailsLoading: true,
        useBackendOrdersRead: true,
      }),
    ).toBe(false);
  });

  it('still waits for legacy details when backend order read is disabled', () => {
    expect(
      shouldShowOrderLoading({
        orderLoading: false,
        detailsLoading: true,
        useBackendOrdersRead: false,
      }),
    ).toBe(true);
  });

  it('always waits for the order header query', () => {
    expect(
      shouldShowOrderLoading({
        orderLoading: true,
        detailsLoading: false,
        useBackendOrdersRead: true,
      }),
    ).toBe(true);
  });
});
