import { Tooltip } from '../../ui/tooltipDelay';
import React, { useMemo } from 'react';
import { GRAIN_TEXT, barGrain, barRangeText, dateBars, type DayValue } from './dateBars';
import './dateBars.css';

/**
 * Bars over a date axis: one bar a day, a week or a month depending on the period, with the date
 * written under every bar (the day of the month for days) and the month named where it starts.
 * `formatValue` — the value in the hint and above the tallest bars.
 */
export function DateBarsChart({
  days,
  formatValue,
  unit,
  tone = 'a',
  ariaLabel,
}: {
  days: readonly DayValue[];
  formatValue: (value: number) => string;
  /** What `count` counts, e.g. «пл.» or «зак.»; omitted — the count is not shown. */
  unit?: string;
  tone?: 'a' | 'b' | 'c' | 'd';
  ariaLabel: string;
}) {
  const grain = barGrain(days.length);
  const bars = useMemo(() => dateBars(days, grain), [days, grain]);
  // with many bars every second label is dropped so that the rest stay readable
  const labelEvery = bars.length > 32 ? 2 : 1;
  return (
    <div className="date-bars" data-grain={grain} data-tone={tone} role="img" aria-label={`${ariaLabel}, ${GRAIN_TEXT[grain]}`}>
      <div className="date-bars__plot" style={{ gridTemplateColumns: `repeat(${Math.max(1, bars.length)}, minmax(0, 1fr))` }}>
        {bars.map((bar, index) => (
          <Tooltip key={bar.key} title={`${barRangeText(bar)}: ${formatValue(bar.value)}${unit ? ` · ${bar.count} ${unit}` : ''}`}>
            <div className="date-bars__col" data-empty={bar.value === 0 ? 'true' : undefined} data-month-start={bar.caption && index > 0 ? 'true' : undefined}>
              <div className="date-bars__track"><i style={{ height: `${bar.value > 0 ? Math.max(3, bar.share * 100) : 0}%` }} /></div>
              <div className="date-bars__label">{index % labelEvery === 0 ? bar.label : ''}</div>
              <div className="date-bars__caption">{bar.caption ?? ''}</div>
            </div>
          </Tooltip>
        ))}
      </div>
    </div>
  );
}
