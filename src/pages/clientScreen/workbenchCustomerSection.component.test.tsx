import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it } from 'vitest';
import { useWorkbenchCustomerSection, type WorkbenchCustomerInputs } from './workbenchCustomerSection';

const MAIN = ['basic', 'dates', 'details', 'services', 'finance'];
const isOpen = (key: string) => MAIN.includes(key);

type Props = WorkbenchCustomerInputs & { orderKey: string; active: boolean };
const seen: string[] = [];
const Probe: React.FC<Props> = (props) => {
  seen.push(useWorkbenchCustomerSection({ ...props, isOpen }));
  return null;
};

let renderer: ReactTestRenderer | null = null;
const render = (props: Props) => act(() => {
  if (renderer) renderer.update(<Probe {...props} />);
  else renderer = create(<Probe {...props} />);
});
const rebuild = (props: Props) => {
  act(() => renderer?.unmount());
  renderer = null;
  render(props);
};
const section = () => seen.at(-1);
let order = 0;
const base = (over: Partial<Props> = {}): Props => ({
  orderKey: `order-${order}`, active: true, activeTab: 'details', pinned: null, spy: 'details', foldsKey: '', navigationSeq: 0, ...over,
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  seen.length = 0;
  order += 1;
});

describe('NewLine customer section across the workspace lifecycle', () => {
  it('follows scrolling while the form is on its page', () => {
    render(base({ spy: null }));
    render(base({ spy: 'finance' }));
    expect(section()).toBe('finance');
  });

  it('stays put while the form is hidden, whatever the hidden form reports', () => {
    render(base({ spy: null }));
    render(base({ spy: 'finance' }));
    render(base({ spy: 'finance', active: false }));
    render(base({ spy: 'basic', activeTab: 'basic', active: false }));
    render(base({ spy: 'basic', activeTab: 'basic', navigationSeq: 1, active: false }));
    expect(section()).toBe('finance');
  });

  it('a form rebuilt while hidden starts from the kept section, not from its own state', () => {
    render(base({ spy: null }));
    render(base({ spy: 'finance' }));
    render(base({ spy: 'finance', active: false }));
    rebuild(base({ spy: null, activeTab: 'basic', active: false }));
    expect(section()).toBe('finance');
  });

  it('back on its page it takes the section in view, also one measured before it was hidden', () => {
    render(base({ spy: null }));
    render(base({ spy: 'finance' }));
    // the form measured the top while it was being hidden (the app scrolled the window up)
    render(base({ spy: 'basic', active: false }));
    expect(section()).toBe('finance');
    // back: nothing new is measured, yet the top is what the manager sees
    render(base({ spy: 'basic', active: true }));
    expect(section()).toBe('basic');
  });

  it('rebuilt and back on its page: the first measurement brings the customer to it, then it follows', () => {
    render(base({ spy: null }));
    render(base({ spy: 'finance' }));
    render(base({ spy: 'finance', active: false }));
    rebuild(base({ spy: null, activeTab: 'basic', active: false }));
    render(base({ spy: null, activeTab: 'basic', active: true }));
    expect(section()).toBe('finance');
    render(base({ spy: 'basic', activeTab: 'basic', active: true }));
    expect(section()).toBe('basic');
    render(base({ spy: 'services', activeTab: 'basic', active: true }));
    expect(section()).toBe('services');
  });

  it('a form rebuilt on its page treats its current inputs as the starting point, not as a navigation', () => {
    render(base({ spy: null }));
    render(base({ spy: 'finance' }));
    rebuild(base({ spy: null, activeTab: 'basic' }));
    expect(section()).toBe('finance');
    render(base({ spy: null, activeTab: 'details', navigationSeq: 1 }));
    expect(section()).toBe('details');
  });
});
