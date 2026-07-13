import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Node-тест-env без jsdom: рендер-поверхность фиксируем source-text guard'ом.
 * Контракт карточки узла (верхний блок выделенной панели на вкладке «Панели»):
 * список свойств спрятан под спойлер, свёрнутый по дефолту; SVG-схема панели
 * рендерится БЕЗ спойлера.
 */
const nodeCard = readFileSync(new URL('./NodeCard.tsx', import.meta.url), 'utf8');

describe('bazis node card spoiler guards', () => {
  it('свойства узла — под спойлером, свёрнутым по дефолту', () => {
    // отдельный Collapse c panel key="summary", внутри — Descriptions
    expect(nodeCard).toMatch(/key="summary"[\s\S]*?<Descriptions/);
    // спойлер свойств свёрнут по дефолту: у его Collapse нет defaultActiveKey
    const summaryCollapse = nodeCard.match(/<Collapse[^>]*>\s*<Collapse\.Panel[^>]*key="summary"/);
    expect(summaryCollapse?.[0]).toBeTruthy();
    expect(summaryCollapse?.[0]).not.toContain('defaultActiveKey');
  });

  it('SVG-схема панели рендерится вне спойлеров', () => {
    expect(nodeCard).toContain('<PanelDiagram');
    // PanelDiagram не обёрнут в Collapse: между закрытием summary-спойлера и
    // диаграммой нет открывающего Collapse
    const diagramIdx = nodeCard.indexOf('<PanelDiagram');
    const summaryEnd = nodeCard.indexOf('</Collapse>');
    expect(summaryEnd).toBeGreaterThan(-1);
    expect(diagramIdx).toBeGreaterThan(summaryEnd);
    const between = nodeCard.slice(summaryEnd, diagramIdx);
    expect(between).not.toContain('<Collapse');
  });
});
