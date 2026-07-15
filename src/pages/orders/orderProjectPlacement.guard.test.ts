import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./show.tsx', import.meta.url), 'utf8');

describe('order project placement', () => {
  it('renders the clickable project inside Additional information before Dates', () => {
    const additionalPanel = source.indexOf("activeInfoPanel === 'additional'");
    const projectBlock = source.indexOf('aria-label="Проект заказа"', additionalPanel);
    const datesBlock = source.indexOf('<OrderDatesBlock', additionalPanel);

    expect(additionalPanel).toBeGreaterThanOrEqual(0);
    expect(projectBlock).toBeGreaterThan(additionalPanel);
    expect(datesBlock).toBeGreaterThan(projectBlock);

    const projectMarkup = source.slice(projectBlock, datesBlock);
    expect(projectMarkup).toContain('to={`/projects/show/${projectId}`}');
    expect(projectMarkup).toContain('borderBottom:');
  });

  it('does not duplicate project information above the section tabs', () => {
    expect(source.match(/to=\{`\/projects\/show\/\$\{projectId\}`\}/g)).toHaveLength(1);
  });
});
