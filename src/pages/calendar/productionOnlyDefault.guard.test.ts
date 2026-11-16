import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('calendar «Только производство»', () => {
  it('is off by default: the calendar opens with all orders (user decision 04.11)', () => {
    const board = readFileSync('src/pages/calendar/components/CalendarBoard.tsx', 'utf8');
    expect(board).toContain('const [productionOnly, setProductionOnly] = useState(false);');
  });
});
