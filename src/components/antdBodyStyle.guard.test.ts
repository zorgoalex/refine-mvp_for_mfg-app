import { describe, expect, it } from 'vitest';
import { bodyStyleCases, readBodyStyleProps } from '../../tests/helpers/antdBodyStyleCases';

describe('AntD modal/drawer body styles', () => {
  for (const { name, file, tag, expected } of bodyStyleCases) {
    it(`${name}: uses the installed AntD bodyStyle contract without losing CSS`, () => {
      expect(readBodyStyleProps(file, tag)).toEqual({ bodyStyle: expected });
    });
  }
});
