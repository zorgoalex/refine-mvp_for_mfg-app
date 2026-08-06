import React from 'react';
import { describe, expect, it } from 'vitest';
import { BasisProjectLink, basisProjectPath } from './BasisProjectLink';

describe('BasisProjectLink', () => {
  it('builds links only for valid project ids', () => {
    expect(basisProjectPath(41)).toBe('/bazis/projects/41');
    expect(basisProjectPath('41')).toBe('/bazis/projects/41');
    expect(basisProjectPath(0)).toBeNull();
    expect(basisProjectPath('not-an-id')).toBeNull();
    expect(basisProjectPath(true)).toBeNull();
  });

  it('renders accessible in-app navigation for a linked Basis-project', () => {
    const element = BasisProjectLink({ value: '1491', bazisProjectId: 41, enabled: true });

    expect(React.isValidElement(element)).toBe(true);
    expect((element as React.ReactElement<any>).props.to).toBe('/bazis/projects/41');
    expect((element as React.ReactElement<any>).props['aria-label']).toBe('Открыть Базис-проект 1491');
  });

  it('keeps unlinked or forbidden values as plain text', () => {
    const element = BasisProjectLink({ value: '1491', bazisProjectId: 41, enabled: false });

    expect(React.isValidElement(element)).toBe(true);
    expect((element as React.ReactElement<any>).props.to).toBeUndefined();
    expect((element as React.ReactElement<any>).props.children).toBe('1491');
  });
});
