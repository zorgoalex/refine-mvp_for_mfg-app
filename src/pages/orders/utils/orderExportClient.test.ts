import { describe, expect, it } from 'vitest';
import { resolveOrderExportClientName, toOrderExportClient } from './orderExportClient';

describe('resolveOrderExportClientName', () => {
  it('uses the order record client name when it is present', () => {
    expect(
      resolveOrderExportClientName(
        { client_name: '  Client From Record  ' },
        { header: { client_name: 'Client From Backend' } },
        { client_name: 'Client From Clients Table' },
      ),
    ).toBe('Client From Record');
  });

  it('falls back to backend order header client name', () => {
    expect(
      resolveOrderExportClientName(
        { client_name: '' },
        { header: { client_name: 'Client From Backend' } },
        { client_name: 'Client From Clients Table' },
      ),
    ).toBe('Client From Backend');
  });

  it('falls back to the clients table record when the order payload has no client name', () => {
    expect(
      resolveOrderExportClientName(
        { client_name: null },
        { header: { client_name: '   ' } },
        { client_name: 'Client From Clients Table' },
      ),
    ).toBe('Client From Clients Table');
  });

  it('returns null when no non-empty client name exists', () => {
    expect(
      resolveOrderExportClientName(
        { client_name: undefined },
        { header: { client_name: '' } },
        { client_name: '   ' },
      ),
    ).toBeNull();
  });
});

describe('toOrderExportClient', () => {
  it('builds the Excel client object from a resolved name', () => {
    expect(toOrderExportClient('Client A')).toEqual({ client_name: 'Client A' });
  });

  it('returns null when the name is missing', () => {
    expect(toOrderExportClient(null)).toBeNull();
  });
});
