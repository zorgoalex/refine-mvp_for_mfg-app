import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const view = readFileSync(new URL('./BazisProjectViewPage.tsx', import.meta.url), 'utf8');
const api = readFileSync(new URL('../../api/bazisApi.ts', import.meta.url), 'utf8');

describe('Bazis project card header guards', () => {
  it('prefixes the workspace tab title with БП', () => {
    expect(view).toContain('`БП ${projectCard.name.trim()}`');
  });

  it('shows owning ERP project name with a link', () => {
    expect(view).toContain('projectCard.projectName?.trim()');
    expect(view).toContain('ERP-проект:');
    expect(view).toContain('/projects/show/${projectCard.projectId}');
  });

  it('offers manager-only accessible rename controls with keyboard support', () => {
    expect(view).toContain("can('bazis.manage')");
    expect(view).toContain('bazisApi.renameProject');
    expect(view).toContain('aria-label="Изменить название Базис-проекта"');
    expect(view).toContain('onPressEnter');
    expect(view).toContain("event.key === 'Escape'");
  });

  it('uses PATCH for the rename command', () => {
    expect(api).toMatch(/renameProject[\s\S]*httpClient\.patch/);
  });

  it('exports selected panels as direct Basis-cut XLS from the project card', () => {
    expect(view).toContain('const canExportBazisXls = canManage');
    expect(view).toContain("const canViewBazisCut = can('cut.view')");
    expect(view).toContain('Доступно менеджеру и выше');
    expect(view).toContain('canExportXls={canExportBazisXls}');
    expect(view).not.toContain('exportTemplatesReady');
    expect(view).toContain('bazisApi.exportCutXls(selectedRevision.bazisRevisionId, nodeIds, exportTemplateId)');
    expect(view).toContain('<ExportTemplateSelect');
    expect(view).toContain('onSelectionChange={setSelectedPanelNodeIds}');
    expect(view).toContain('Экспорт XLS');
    expect(api).toMatch(/exportCutXls[\s\S]*revisionCutXls[\s\S]*selectedNodeIds/);
  });
});
