import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../common/errors/api-error';
import {
  classifyOrderStatusBoardError,
  parseOrderStatusBoardQuery,
} from './order-status-board.controller';

describe('parseOrderStatusBoardQuery', () => {
  it('parses defaults and bounded filters', () => {
    expect(
      parseOrderStatusBoardQuery({
        board: 'production',
        column: 'unassigned',
        limit: '40',
        search: ' МП-100 ',
        onlyMyOrders: 'true',
        overdueOnly: 'false',
        includeDone: 'true',
        plannedFrom: '2026-07-01',
        plannedTo: '2026-07-31',
      }),
    ).toEqual({
      board: 'production',
      column: 'unassigned',
      limit: 40,
      search: 'МП-100',
      onlyMyOrders: true,
      overdueOnly: false,
      includeDone: true,
      plannedFrom: '2026-07-01',
      plannedTo: '2026-07-31',
    });
  });

  it('normalizes numeric columns and defaults the page size', () => {
    expect(parseOrderStatusBoardQuery({ board: 'order', column: '004' })).toEqual({
      board: 'order',
      column: '4',
      limit: 24,
      onlyMyOrders: false,
      overdueOnly: false,
      includeDone: false,
    });
  });

  it.each([
    [{}, 'board'],
    [{ board: 'payment' }, 'board'],
    [{ board: 'order', column: 'unassigned' }, 'column'],
    [{ board: 'order', column: '999999999999999999999' }, 'column'],
    [{ board: 'order', cursor: 'cursor-without-column' }, 'cursor'],
    [{ board: 'order', limit: '61' }, 'limit'],
    [{ board: 'order', onlyMyOrders: '1' }, 'onlyMyOrders'],
    [{ board: 'production', includeDone: '1' }, 'includeDone'],
    [{ board: 'order', includeDone: 'true' }, 'includeDone'],
    [{ board: 'order', plannedFrom: '19.07.2026' }, 'plannedFrom'],
    [{ board: 'order', plannedFrom: '2026-02-30' }, 'plannedFrom'],
    [{ board: 'order', plannedFrom: '0000-01-01' }, 'plannedFrom'],
    [{ board: ['order'] }, 'board'],
    [{ board: 'order', search: { nested: 'value' } }, 'search'],
    [
      { board: 'order', plannedFrom: '2026-08-01', plannedTo: '2026-07-01' },
      'plannedFrom',
    ],
  ])('rejects invalid query %o', (query, field) => {
    expect(() => parseOrderStatusBoardQuery(query)).toThrow(ApiError);
    try {
      parseOrderStatusBoardQuery(query);
    } catch (error) {
      expect(error).toMatchObject({ statusCode: 422, details: { field } });
    }
  });
});

describe('classifyOrderStatusBoardError', () => {
  it('separates database statement timeouts from generic failures', () => {
    expect(classifyOrderStatusBoardError({ code: '57014' })).toBe('DATABASE_TIMEOUT');
    expect(classifyOrderStatusBoardError(new Error('boom'))).toBe('INTERNAL_ERROR');
    expect(
      classifyOrderStatusBoardError(new ApiError(422, 'BOARD_CURSOR_INVALID', 'bad')),
    ).toBe('BOARD_CURSOR_INVALID');
  });
});
