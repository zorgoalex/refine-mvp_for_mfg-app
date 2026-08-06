import { describe, expect, it } from 'vitest';
import { noteRequiresDoweling } from './order-doweling';

describe('noteRequiresDoweling', () => {
  it.each([
    ['Присадка', true],
    ['нужна присадка.', true],
    ['ПРИСАДКА/маршрут', true],
    ['до-присадка после', true],
    ['неприсадка', false],
    ['присадками', false],
    ['', false],
    [null, false],
  ])('matches a separate trigger word in %j', (note, expected) => {
    expect(noteRequiresDoweling(note)).toBe(expected);
  });
});
