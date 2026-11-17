import { describe, expect, it } from 'vitest';
import { parseSvgCutUploadFileNameHints } from './svgCutUploadFilename';

describe('parseSvgCutUploadFileNameHints', () => {
  it('extracts machine and plus-separated order numbers', () => {
    expect(parseSvgCutUploadFileNameHints('CNC#2_2756+2776+2779+2790.svg')).toEqual({
      machineName: 'CNC#2',
      orderNames: ['2756', '2776', '2779', '2790'],
      materialName: null,
    });
  });

  it('extracts MDF thickness suffix', () => {
    expect(parseSvgCutUploadFileNameHints('CNC#1_2783-8MM.svg')).toEqual({
      machineName: 'CNC#1',
      orderNames: ['2783'],
      materialName: 'МДФ 8мм',
    });
  });

  it('extracts HDF material suffix without treating it as an order', () => {
    expect(parseSvgCutUploadFileNameHints('CNC#1_2777+2723-HDF.svg')).toEqual({
      machineName: 'CNC#1',
      orderNames: ['2777', '2723'],
      materialName: 'ХДФ',
    });
  });

  it('handles filename without material suffix', () => {
    expect(parseSvgCutUploadFileNameHints('CNC#1_2769+2767.svg')).toEqual({
      machineName: 'CNC#1',
      orderNames: ['2769', '2767'],
      materialName: null,
    });
  });

  it('extracts common non-MDF material suffixes', () => {
    expect(parseSvgCutUploadFileNameHints('CNC#1_2777-LDSP.svg')).toMatchObject({
      orderNames: ['2777'],
      materialName: 'ЛДСП',
    });
    expect(parseSvgCutUploadFileNameHints('CNC#1_2777+2723-FANERA12MM.svg')).toMatchObject({
      orderNames: ['2777', '2723'],
      materialName: 'Фанера 12мм',
    });
  });

  it('keeps the whole order name with a dash or letters', () => {
    expect(parseSvgCutUploadFileNameHints('CNC#2_3160-1+3179-18MM.svg')).toEqual({
      machineName: 'CNC#2',
      orderNames: ['3160-1', '3179'],
      materialName: 'МДФ 18мм',
    });
    expect(parseSvgCutUploadFileNameHints('CNC#1_1604-дубль+1499.svg').orderNames).toEqual(['1604-дубль', '1499']);
    expect(parseSvgCutUploadFileNameHints('CNC#1_3160-1.svg').orderNames).toEqual(['3160-1']);
    expect(parseSvgCutUploadFileNameHints('CNC#1_#3160+№3161.svg').orderNames).toEqual(['3160', '3161']);
    expect(parseSvgCutUploadFileNameHints('CNC#1_3160_3161.svg').orderNames).toEqual(['3160', '3161']);
  });
});
