import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { LabelTemplate, OrderLabelsPreview } from '../../../../api/types/labelsApi.types';
import { OrderLabelGeneratePreviewSurface } from './OrderLabelGenerateAction';
import { OrderLabelInlinePreviewSurface } from './OrderLabelDataEditor';
import { OrderLatestLabelPreviewSurface } from './OrderLatestLabelsPreview';

const svg = '<svg viewBox="0 0 20 10"><rect width="20" height="10"/></svg>';

describe('order label preview surfaces', () => {
  it('renders the generation modal preview through the shared outlined frame', () => {
    const template = {
      labelTemplateId: 1,
      name: 'Label',
      version: 1,
      isActive: true,
      canvasWidthMm: 20,
      canvasHeightMm: 10,
      dpi: 203,
      defaultExportFormats: ['png'],
      customFieldSchema: {},
      fieldCatalogSnapshot: {},
      rendererCapabilities: ['if_else_v1', 'typography_v1'],
      elements: [],
    } as LabelTemplate;
    const preview = { labelCount: 1, svgPages: [svg] } as OrderLabelsPreview;
    const html = renderToStaticMarkup(
      <OrderLabelGeneratePreviewSurface preview={preview} template={template} />,
    );
    expect(html).toContain('order-label-pages-viewer');
    expect(html).toContain('Список бирок');
    expect(html).toContain('label-svg-preview-frame__content');
    expect(html).toContain('<svg viewBox="0 0 20 10">');
  });

  it('renders the latest-card preview through the shared outlined frame', () => {
    const html = renderToStaticMarkup(
      <OrderLatestLabelPreviewSurface svg={svg} zoomed={false} />,
    );
    expect(html).toContain('label-svg-preview-frame__content');
    expect(html).toContain('outline:1px solid var(--label-preview-outline, rgba(0,0,0,0.1))');
  });

  it('shrink-wraps the inline-editor SVG inside the padded preview area', () => {
    const html = renderToStaticMarkup(<OrderLabelInlinePreviewSurface svg={svg} />);
    expect(html).toContain('padding:12px');
    expect(html).toContain('order-label-inline-preview-fit');
    expect(html).toContain('display:inline-block');
    expect(html).toContain('outline:1px solid var(--label-preview-outline, rgba(0,0,0,0.1))');
  });
});
