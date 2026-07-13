import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Node-тест-env без jsdom: рендер-поверхность и call-sites фиксируем
 * source-text guard'ами. Контракт (scope = вкладка «Панели», верхний блок
 * выделенной панели): список свойств спрятан под спойлер, свёрнутый по
 * дефолту; SVG-схема — БЕЗ спойлера. Остальные потребители NodeCard
 * (вкладки «Дерево», «Фурнитура», спойлеры предков) НЕ затронуты — спойлер
 * включается пропом collapsibleSummary только по месту (critic R1).
 */
const nodeCard = readFileSync(new URL('./NodeCard.tsx', import.meta.url), 'utf8');
const panelsTab = readFileSync(new URL('./PanelsTab.tsx', import.meta.url), 'utf8');
const hardwareTab = readFileSync(new URL('./HardwareTab.tsx', import.meta.url), 'utf8');
const viewPage = readFileSync(new URL('./BazisProjectViewPage.tsx', import.meta.url), 'utf8');

describe('bazis node card spoiler guards', () => {
  it('спойлер свойств опциональный: collapsibleSummary, по дефолту ВЫКЛЮЧЕН', () => {
    expect(nodeCard).toContain('collapsibleSummary');
    expect(nodeCard).toMatch(/collapsibleSummary\s*=\s*false/);
    // при включении — panel key="summary" со свойствами внутри, без defaultActiveKey
    expect(nodeCard).toMatch(/const summary = \(\s*<Descriptions/);
    expect(nodeCard).toMatch(/key="summary"[\s\S]*?\{summary\}/);
    expect(nodeCard).not.toMatch(/<Collapse[^>]*defaultActiveKey[^>]*>\s*<Collapse\.Panel[^>]*key="summary"/);
  });

  it('спойлер включён ТОЛЬКО у верхней карточки панели на вкладке «Панели»', () => {
    // top card выделенной панели
    expect(panelsTab).toMatch(/<NodeCard nodeId=\{selectedId\} collapsibleSummary \/>/);
    // предки на «Панелях» и другие вкладки — без спойлера свойств
    expect(panelsTab.match(/collapsibleSummary/g)).toHaveLength(1);
    expect(hardwareTab).not.toContain('collapsibleSummary');
    expect(viewPage).not.toContain('collapsibleSummary');
  });

  it('SVG-схема панели рендерится вне спойлеров', () => {
    expect(nodeCard).toContain('<PanelDiagram');
    const diagramIdx = nodeCard.indexOf('<PanelDiagram');
    const summaryEnd = nodeCard.indexOf('</Collapse>');
    expect(summaryEnd).toBeGreaterThan(-1);
    expect(diagramIdx).toBeGreaterThan(summaryEnd);
    const between = nodeCard.slice(summaryEnd, diagramIdx);
    expect(between).not.toContain('<Collapse');
  });
});
