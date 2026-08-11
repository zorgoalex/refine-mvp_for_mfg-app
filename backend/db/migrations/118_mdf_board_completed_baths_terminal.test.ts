import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const sql = readFileSync(
  fileURLToPath(new URL('./118_mdf_board_completed_baths_terminal.sql', import.meta.url)),
  'utf8',
);

describe('118_mdf_board_completed_baths_terminal migration', () => {
  it('extends MDF manual move checks with the completed bath terminal column', () => {
    expect(sql).toContain('DROP CONSTRAINT IF EXISTS chk_mdf_board_manual_moves_target_column');
    expect(sql).toContain('DROP CONSTRAINT IF EXISTS chk_mdf_board_manual_moves_kind_target');
    expect(sql).toContain("'completed_baths'");
    expect(sql).toContain(
      "target_column IN ('baths', 'baths_ready', 'baths_laminated', 'completed_baths')",
    );
    expect(sql).toContain('mdf-board-manual-moves-v2: includes completed_baths terminal bath column');
  });
});
