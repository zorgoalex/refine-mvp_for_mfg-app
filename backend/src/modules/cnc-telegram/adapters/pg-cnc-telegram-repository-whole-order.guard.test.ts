import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const source = readFileSync(fileURLToPath(new URL('./pg-cnc-telegram-repository.ts', import.meta.url)), 'utf8');

describe('MDF whole-order projection', () => {
  it('uses normalized keys and retains non-MDF exclusion', () => {
    const cte = source.slice(
      source.indexOf('completed_whole_order_keys AS ('),
      source.indexOf('whole_order_target_details AS ('),
    );
    expect(cte).toContain('cnc_telegram_packet_whole_order_keys');
    expect(cte).not.toContain('regexp_matches');
    expect(cte).toContain("ARRAY['%hdf%', '%хдф%', '%лдсп%', '%ldsp%', '%fanera%', '%фанера%']");
  });
});
