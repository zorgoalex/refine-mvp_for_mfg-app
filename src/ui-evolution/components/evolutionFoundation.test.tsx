import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EvolutionFormSection, EvolutionPageHeader } from './EvolutionPageHeader';
import { EvolutionStatePanel } from './EvolutionStatePanel';
import { EvolutionStatusBadge } from './EvolutionStatusBadge';

describe('evolution UI foundation', () => {
  it('renders status as readable text plus a decorative color cue', () => {
    const markup = renderToStaticMarkup(<EvolutionStatusBadge label="В производстве" tone="success" />);

    expect(markup).toContain('В производстве');
    expect(markup).toContain('evolution-status-badge--success');
    expect(markup).toContain('aria-hidden="true"');
  });

  it('exposes semantic loading, empty, error, and forbidden states', () => {
    expect(renderToStaticMarkup(<EvolutionStatePanel kind="loading" />)).toContain('role="status"');
    expect(renderToStaticMarkup(<EvolutionStatePanel kind="empty" />)).toContain('Пока нет данных');
    expect(renderToStaticMarkup(<EvolutionStatePanel kind="error" />)).toContain('role="alert"');
    expect(renderToStaticMarkup(<EvolutionStatePanel kind="forbidden" />)).toContain('role="alert"');
  });

  it('provides consistent page and form hierarchy primitives', () => {
    const header = renderToStaticMarkup(
      <EvolutionPageHeader title="Заказы" subtitle="Рабочая очередь" actions={<button>Создать</button>} />,
    );
    const section = renderToStaticMarkup(
      <EvolutionFormSection title="Основное" description="Ключевые поля">Поля</EvolutionFormSection>,
    );

    expect(header).toContain('<h1');
    expect(header).toContain('evolution-page-header__actions');
    expect(section).toContain('<section');
    expect(section).toContain('evolution-form-section__body');
  });
});
