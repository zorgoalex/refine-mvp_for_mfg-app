import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

const sourcePath = resolve(__dirname, 'OrderDetailTable.tsx');
const source = readFileSync(sourcePath, 'utf8');

describe('OrderDetailTable reference cells', () => {
  it('keeps table reference cells pure and map-backed', () => {
    expect(source).toContain('const MaterialCell: React.FC');
    expect(source).toContain('namesById: Map<number, string>');
    expect(source).toContain('resolveReferenceLabel(materialId, namesById)');
    expect(source).toContain('resolveReferenceLabel(millingTypeId, namesById)');
    expect(source).toContain('resolveReferenceLabel(edgeTypeId, namesById)');
    expect(source).toContain('resolveReferenceLabel(filmId, namesById)');
    expect(source).toContain('resolveReferenceLabel(statusId, namesById)');
  });

  it('does not call useOne inside reference cell component bodies', () => {
    const cellBlock = source.slice(source.indexOf('const MaterialCell: React.FC'));
    expect(cellBlock).not.toMatch(/useOne\s*\(/);
  });
});
