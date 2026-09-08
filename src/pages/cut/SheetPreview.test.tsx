import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SheetPreview } from './SheetPreview';
import { buildSheetPieceOverlays } from './cutPreviewHelpers';

describe('canonical SVG labels in sheet preview', () => {
  it('keeps ERP hover targets while removing duplicate visual labels from SVG images', () => {
    const overlays = buildSheetPieceOverlays({trim_mm:{left:0,right:0,top:0,bottom:0},sheet_width_mm:1000,sheet_height_mm:1000,
      pieces:[{item_id:'svg-1',instance:1,x_mm:0,y_mm:0,width_mm:500,height_mm:500,rotated:false,
        label:{orderId:12,orderName:'ERP overlay label',detailNumber:3,widthMm:500,heightMm:500}}]},[],false,true);
    const render = (labelsInImage: boolean) => renderToStaticMarkup(<SheetPreview src="canonical.png" alt="Лист 1"
      widthMm={1000} heightMm={1000} landscape={false} full overlays={overlays} labelsInImage={labelsInImage}/>);
    expect(render(false)).toContain('ERP overlay label');
    expect(render(true)).not.toContain('ERP overlay label');
    expect(render(true)).toContain('aria-label="Заказ 12, позиция 3"');
    expect(render(true)).toContain('src="canonical.png"');
  });
});
