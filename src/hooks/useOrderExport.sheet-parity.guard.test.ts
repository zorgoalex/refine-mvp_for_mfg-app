import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

// SP3 Task 12: the FRONTEND Excel/Google-Drive export must resolve each detail's
// material name via the server COALESCE (order_details_view), NOT fetch
// sheet_material_types client-side (RBAC), and must still export a header-only
// sheet order. Verified as a source-text guard (node env, no DOM).
const src = readFileSync(new URL('./useOrderExport.ts', import.meta.url), 'utf8');

describe('useOrderExport sheet material parity', () => {
  it('resolves the detail material name through the shared COALESCE helper', () => {
    expect(src).toContain('resolveDetailMaterialName');
  });

  it('reads the server-resolved per-detail name from order_details_view', () => {
    expect(src).toMatch(/resource:\s*['"]order_details_view['"]/);
  });

  it('does NOT fetch sheet_material_types client-side (order viewers lack the perm)', () => {
    expect(src).not.toMatch(/resource:\s*['"]sheet_material_types['"]/);
  });

  it('uses the orders_view header material name for the header fallback', () => {
    expect(src).toContain('resolveHeaderMaterialName');
    expect(src).toMatch(/material_name:\s*orderView\.material_name/);
  });

  it('does not hard-skip a header-only order (no details) before export', () => {
    // the early-return must require BOTH no details AND no header material
    expect(src).toMatch(/details\.length === 0 && !headerMaterialName/);
  });
});
