import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { labelsApi } from '../../api/labelsApi';
import type { DetailLabelsPreview, LabelTemplate } from '../../api/types/labelsApi.types';
import { printLabelSvgPages } from '../orders/components/labels/labelPrint';
import { CutSheetLabelGenerateAction } from './CutSheetLabelGenerateAction';

vi.mock('../../api/labelsApi', () => ({
  labelsApi: {
    listTemplates: vi.fn(), previewDetailLabels: vi.fn(), generateDetailLabels: vi.fn(),
    downloadDetailGeneration: vi.fn(),
  },
}));
vi.mock('../../api/authSession', () => ({ authSession: { getUser: () => ({ id: 1 }) } }));
vi.mock('../../utils/permissions', () => ({ can: () => true }));
vi.mock('../orders/components/labels/labelPrint', () => ({ printLabelSvgPages: vi.fn(() => true) }));
vi.mock('../orders/components/labels/labelDownloads', () => ({ saveLabelBlob: vi.fn() }));
vi.mock('../orders/components/labels/labelTemplatePreference', () => ({
  loadAppendBlankLabelOnPrintPreference: () => false,
  resolvePreferredLabelTemplateId: () => 1,
  saveAppendBlankLabelOnPrintPreference: vi.fn(), saveLabelTemplatePreference: vi.fn(),
}));
vi.mock('../../ui/tooltipDelay', () => ({ Tooltip: ({ children }: React.PropsWithChildren) => children }));
vi.mock('antd', () => {
  const Box = ({ children }: React.PropsWithChildren) => <div>{children}</div>;
  const Checkbox = Object.assign(Box, { Group: Box });
  return {
    Button: ({ children, onClick, disabled }: React.ButtonHTMLAttributes<HTMLButtonElement>) =>
      <button onClick={onClick} disabled={disabled}>{children}</button>,
    Space: Box, Checkbox, Select: Box, Typography: { Text: Box },
    Alert: ({ message, description }: { message: React.ReactNode; description: React.ReactNode }) =>
      <aside>{message}{description}</aside>,
    Modal: ({ open, children, footer }: React.PropsWithChildren<{ open: boolean; footer: React.ReactNode }>) =>
      open ? <section>{children}{footer}</section> : null,
    message: { error: vi.fn(), warning: vi.fn(), success: vi.fn() },
  };
});

const template: LabelTemplate = {
  labelTemplateId: 1, name: 'Тест', description: null, version: 1, isActive: true,
  canvasWidthMm: 85, canvasHeightMm: 55, dpi: 203, defaultExportFormats: ['png'],
  customFieldSchema: {}, fieldCatalogSnapshot: {}, rendererCapabilities: [], elements: [],
};
const partial: DetailLabelsPreview = {
  generationScope: 'details', templateId: 1, templateVersion: 1, labelCount: 1,
  rows: [], svgPages: ['<svg id="available"/>'], previewToken: 'partial-token',
  skippedRows: [{ orderId: 20, detailId: 11, copyIndex: 1,
    code: 'LABEL_CUT_SHEET_PLACEMENT_MISSING', message: 'Размещение экземпляра на листе раскроя недоступно' }],
};
let root: ReactTestRenderer;
const button = (label: string) => root.root.findAllByType('button')
  .find((node) => node.children.join('') === label)!;
const click = async (label: string) => {
  expect(button(label).props.disabled).not.toBe(true);
  await act(async () => { await button(label).props.onClick(); });
};
async function open() {
  await act(async () => {
    root = create(<CutSheetLabelGenerateAction
      detailInstances={[{ detailId: 10, instance: 1 }, { detailId: 11, instance: 1 }]}
      cutJobId={30} cutGroupId={40} sheetIndex={0}
    />);
  });
  await click('Бирки');
}

describe('partial sheet label print flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(labelsApi.listTemplates).mockResolvedValue([template]);
    vi.mocked(labelsApi.previewDetailLabels).mockResolvedValue(partial);
    vi.mocked(labelsApi.generateDetailLabels).mockResolvedValue({
      generationId: 7, orderId: null, templateId: 1, templateVersion: 1,
      labelCount: 1, generatedAt: '2026-09-08T00:00:00Z',
    });
    vi.mocked(labelsApi.downloadDetailGeneration).mockResolvedValue({ blob: new Blob(), fileName: 'test.zip' });
  });
  afterEach(() => { if (root) act(() => root.unmount()); });

  it('shows omitted instances and prints only available pages', async () => {
    await open();
    expect(JSON.stringify(root.toJSON())).toContain('Пропущено: 1');
    expect(JSON.stringify(root.toJSON())).toContain('деталь 11, экземпляр 1');
    await click('Печать');
    expect(printLabelSvgPages).toHaveBeenCalledWith(partial.svgPages, expect.any(String), { appendBlankPage: false });
  });

  it('generates ZIP using the refreshed partial preview token and original scope', async () => {
    await open();
    await click('Скачать ZIP');
    expect(labelsApi.generateDetailLabels).toHaveBeenCalledWith(expect.objectContaining({
      previewToken: 'partial-token',
      detailIds: [10, 11],
      cutSheetScope: expect.objectContaining({
        detailInstances: [{ detailId: 10, instance: 1 }, { detailId: 11, instance: 1 }],
      }),
    }));
    expect(labelsApi.downloadDetailGeneration).toHaveBeenCalledWith(7);
  });

  it('disables print and ZIP when all rows are omitted', async () => {
    vi.mocked(labelsApi.previewDetailLabels).mockResolvedValue({ ...partial, labelCount: 0, svgPages: [] });
    await open();
    expect(button('Печать').props.disabled).toBe(true);
    expect(button('Скачать ZIP').props.disabled).toBe(true);
    expect(printLabelSvgPages).not.toHaveBeenCalled();
    expect(labelsApi.generateDetailLabels).not.toHaveBeenCalled();
  });

  it.each(['Печать', 'Скачать ZIP'])('stops %s if refreshed preview becomes empty', async (action) => {
    await open();
    vi.mocked(labelsApi.previewDetailLabels).mockResolvedValue({ ...partial, labelCount: 0, svgPages: [] });
    await click(action);
    expect(printLabelSvgPages).not.toHaveBeenCalled();
    expect(labelsApi.generateDetailLabels).not.toHaveBeenCalled();
    expect(button('Печать').props.disabled).toBe(true);
  });

  it('clears old printable preview when refresh fails', async () => {
    await open();
    vi.mocked(labelsApi.previewDetailLabels).mockRejectedValue(new Error('unavailable'));
    await click('Обновить предпросмотр');
    expect(button('Печать').props.disabled).toBe(true);
    expect(button('Скачать ZIP').props.disabled).toBe(true);
  });
});
