import { describe, expect, it, vi } from 'vitest';
import { ClientListFactsController } from './client-list-facts.controller';

const user = { id: '7' };
function controller() {
  const facts = vi.fn(async () => ({ data: [] }));
  return { facts, controller: new ClientListFactsController({ facts } as never) };
}

describe('ClientListFactsController', () => {
  it('requires authentication', () => {
    expect(() => controller().controller.list({} as never, { ids: '1' })).toThrowError(expect.objectContaining({ statusCode: 401 }));
  });

  it('passes distinct ids', async () => {
    const { controller: http, facts } = controller();
    await http.list({ user, requestId: 'req-1' } as never, { ids: '3,1,3' });
    expect(facts).toHaveBeenCalledWith(user, [3, 1], 'req-1');
  });

  it.each([
    ['nothing', {}],
    ['not numbers', { ids: '1,abc' }],
    ['a zero id', { ids: '0' }],
    ['SQL in the list', { ids: '1) OR (1=1' }],
    ['too many ids', { ids: Array.from({ length: 101 }, (_, index) => index + 1).join(',') }],
    ['an unknown parameter', { ids: '1', scope: 'all' }],
  ])('rejects %s', (_name, query) => {
    const { controller: http, facts } = controller();
    expect(() => http.list({ user } as never, query)).toThrowError(expect.objectContaining({ statusCode: 400, code: 'VALIDATION_FAILED' }));
    expect(facts).not.toHaveBeenCalled();
  });
});
