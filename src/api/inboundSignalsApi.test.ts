import { describe, expect, it } from 'vitest';
import { normalizeTemplateTest } from './inboundSignalsApi';

describe('normalizeTemplateTest', () => {
  it('passes the units answer through', () => {
    const answer = { matches: [], units: [{ segmentIndex: 0, segmentText: 'Заказ 1 готов', signalCode: 'ready', ruleCodes: ['r'], references: ['1'] }], split: true, tooManyReferences: false };
    expect(normalizeTemplateTest(answer, 'x')).toBe(answer);
  });
  it('reads the old plain array as one unit per rule over the whole text', () => {
    expect(normalizeTemplateTest([{ ruleCode: 'r', signalCode: 'ready', references: ['7'] }], 'Заказ 7 готов')).toEqual({
      matches: [{ ruleCode: 'r', signalCode: 'ready', references: ['7'] }], split: false, tooManyReferences: false,
      units: [{ segmentIndex: 0, segmentText: 'Заказ 7 готов', signalCode: 'ready', ruleCodes: ['r'], references: ['7'] }] });
  });
});
