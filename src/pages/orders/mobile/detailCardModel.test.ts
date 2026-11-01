import { describe, expect, it } from 'vitest';
import { buildDetailCardModel } from './detailCardModel';

const lookups = {
  millingNameOf: () => 'Фрез-1',
  materialNameOf: () => 'МДФ 16мм',
};

describe('buildDetailCardModel', () => {
  it('maps detail row via table lookups', () => {
    const m = buildDetailCardModel(
      { detail_number: 3, height: 716, width: 396, quantity: 2, note: 'кромка 2 мм' },
      lookups,
    );
    expect(m.num).toBe('№3');
    expect(m.size).toBe('396×716 — 2 шт');
    expect(m.material).toBe('МДФ 16мм');
    expect(m.milling).toBe('Фрез-1');
    expect(m.note).toBe('кромка 2 мм');
  });
  it('shows the stage with the «Переделка» round suffix', () => {
    const stage = (name: string) => ({ ...lookups, stageNameOf: () => name });
    expect(buildDetailCardModel({ production_round: 2 }, stage('Распилен')).stage).toBe('Распилен ·2');
    expect(buildDetailCardModel({ production_round: 1 }, stage('Распилен')).stage).toBe('Распилен');
    expect(buildDetailCardModel({}, stage('Новый')).stage).toBe('Новый');
    expect(buildDetailCardModel({ production_round: 3 }, stage('')).stage).toBe('');
    expect(buildDetailCardModel({ production_round: 2 }, lookups).stage).toBe('');
  });
  it('handles empty row', () => {
    const m = buildDetailCardModel({}, { millingNameOf: () => '—', materialNameOf: () => '—' });
    expect(m.num).toBe('№—');
    expect(m.size).toBe('—');
    expect(m.note).toBe('');
  });
});
