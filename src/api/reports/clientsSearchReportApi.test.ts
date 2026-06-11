import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { countClientsAfter, findClientByName } from './clientsSearchReportApi';
import * as client from '../hasuraReportClient';

describe('clientsSearchReportApi', () => {
  beforeEach(() => vi.spyOn(client, 'hasuraReportQuery'));
  afterEach(() => vi.restoreAllMocks());

  it('findClientByName queries clients and returns first row or null', async () => {
    (client.hasuraReportQuery as ReturnType<typeof vi.fn>).mockResolvedValue({ clients: [{ client_id: 9, client_name: 'Acme' }] });
    expect(await findClientByName('Acme')).toMatchObject({ client_id: 9 });
    const [, vars] = (client.hasuraReportQuery as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(vars).toEqual({ clientNamePattern: '%Acme%' });
  });

  it('findClientByName returns null when empty', async () => {
    (client.hasuraReportQuery as ReturnType<typeof vi.fn>).mockResolvedValue({ clients: [] });
    expect(await findClientByName('zz')).toBeNull();
  });

  it('countClientsAfter returns aggregate count', async () => {
    (client.hasuraReportQuery as ReturnType<typeof vi.fn>).mockResolvedValue({ clients_aggregate: { aggregate: { count: 7 } } });
    expect(await countClientsAfter(9)).toBe(7);
  });
});
