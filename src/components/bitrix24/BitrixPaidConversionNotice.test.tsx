import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BitrixPaidConversionNotice } from './BitrixPaidConversionNotice';

describe('paid conversion notice', () => {
  it('is absent when financial fields are omitted or automation is idle', () => {
    expect(renderToStaticMarkup(<BitrixPaidConversionNotice />)).toBe('');
    expect(renderToStaticMarkup(<BitrixPaidConversionNotice status="idle" />)).toBe('');
  });
  it('shows actionable positions guidance without displaying raw errors', () => {
    expect(renderToStaticMarkup(<BitrixPaidConversionNotice status="waiting" reason="POSITIONS_REQUIRED" />)).toContain('Добавьте хотя бы одну деталь');
    expect(renderToStaticMarkup(<BitrixPaidConversionNotice status="waiting" reason="secret SQL error" />)).not.toContain('secret SQL');
    expect(renderToStaticMarkup(<BitrixPaidConversionNotice status="converted" />)).toContain('преобразована');
  });
});
