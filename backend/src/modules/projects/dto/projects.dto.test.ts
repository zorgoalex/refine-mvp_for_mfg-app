import { describe, expect, it } from 'vitest';
import { listProjectsSchema } from './projects.dto';

describe('listProjectsSchema.includeArchived', () => {
  it("parses query string 'false' as false (z.coerce.boolean would give true)", () => {
    expect(listProjectsSchema.parse({ includeArchived: 'false' }).includeArchived).toBe(false);
    expect(listProjectsSchema.parse({ includeArchived: 'true' }).includeArchived).toBe(true);
    expect(listProjectsSchema.parse({ includeArchived: true }).includeArchived).toBe(true);
    expect(listProjectsSchema.parse({}).includeArchived).toBeUndefined();
  });

  it('rejects garbage values', () => {
    expect(() => listProjectsSchema.parse({ includeArchived: 'yes' })).toThrow();
  });
});
