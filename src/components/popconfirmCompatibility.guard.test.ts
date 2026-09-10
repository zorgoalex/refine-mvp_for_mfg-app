import { describe, expect, it } from 'vitest';
import { popconfirmCases, readPopconfirmAttributes } from '../../tests/helpers/popconfirmCases';

describe('Popconfirm compatibility with the locked AntD version', () => {
  it.each(popconfirmCases)('$name renders its warning through the supported title prop', ({ file, index }) => {
    const attributes = readPopconfirmAttributes(file, index);
    expect(attributes.description).toBeUndefined();
    expect(attributes.title).toContain('<PopconfirmContent');
    expect(attributes.onConfirm).toBeTruthy();
  });
});
