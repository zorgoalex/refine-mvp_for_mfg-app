import { describe, expect, it } from 'vitest';
import {
  nextWorkbenchCustomerSection,
  WORKBENCH_CUSTOMER_FALLBACK,
  type WorkbenchCustomerContext,
  type WorkbenchCustomerEvent,
} from './workbenchCustomerSection';

const MAIN = ['basic', 'dates', 'details', 'services', 'finance'];

/** Plays the manager's steps through the reducer, as the hook does (context of each step given with it). */
function play(start: string, steps: Array<[WorkbenchCustomerEvent, Partial<WorkbenchCustomerContext> & { open?: string[] }]>) {
  let section = start;
  const seen: string[] = [];
  for (const [event, partial] of steps) {
    const open = partial.open ?? [];
    section = nextWorkbenchCustomerSection(section, event, {
      pinned: partial.pinned ?? null,
      spy: partial.spy ?? null,
      isOpen: (key) => MAIN.includes(key) || open.includes(key),
    });
    seen.push(section);
  }
  return seen;
}

describe('NewLine: the section the customer follows', () => {
  it('follows plain scrolling from section to section', () => {
    expect(play('details', [
      [{ kind: 'spy', key: 'basic' }, { spy: 'basic' }],
      [{ kind: 'spy', key: 'details' }, { spy: 'details' }],
      [{ kind: 'spy', key: 'finance' }, { spy: 'finance' }],
    ])).toEqual(['basic', 'details', 'finance']);
  });

  it('an anchor click holds its section while the page scrolls there, and after it, until the manager scrolls', () => {
    expect(play('basic', [
      [{ kind: 'navigate', key: 'finance' }, { pinned: 'finance' }],
      [{ kind: 'pin', key: 'finance' }, { pinned: 'finance' }],
      // smooth scroll passes details; a short last section never reaches the line
      [{ kind: 'spy', key: 'details' }, { pinned: 'finance', spy: 'details' }],
      [{ kind: 'spy', key: 'services' }, { pinned: 'finance', spy: 'services' }],
      // the manager's wheel ends the pin: the customer goes where the page is
      [{ kind: 'pin', key: null }, { spy: 'services' }],
    ])).toEqual(['finance', 'finance', 'finance', 'finance', 'services']);
  });

  it('a jump after an anchor click (validation, ?tab=, Ctrl+Tab) wins over the old pin', () => {
    expect(play('basic', [
      [{ kind: 'navigate', key: 'finance' }, { pinned: 'finance' }],
      [{ kind: 'pin', key: 'finance' }, { pinned: 'finance' }],
      [{ kind: 'navigate', key: 'details' }, { pinned: 'finance' }],
      [{ kind: 'spy', key: 'details' }, { pinned: 'finance', spy: 'details' }],
      [{ kind: 'spy', key: 'basic' }, { pinned: 'finance', spy: 'basic' }],
    ])).toEqual(['finance', 'finance', 'details', 'details', 'details']);
  });

  it('a section that is closed is never the customer\'s', () => {
    expect(play('finance', [
      // the fold is opened (a navigation) and scrolled to
      [{ kind: 'navigate', key: 'cut' }, { open: ['cut'] }],
      [{ kind: 'spy', key: 'cut' }, { open: ['cut'], spy: 'cut' }],
      // then closed: the section under the line is finance again
      [{ kind: 'folds' }, { open: [], spy: 'finance' }],
    ])).toEqual(['cut', 'cut', 'finance']);
  });

  it('a fold closed with no open section in view falls back to the details', () => {
    expect(play('cut', [[{ kind: 'folds' }, { open: [], spy: null }]])).toEqual([WORKBENCH_CUSTOMER_FALLBACK]);
    expect(play('cut', [[{ kind: 'folds' }, { open: [], spy: 'cut' }]])).toEqual([WORKBENCH_CUSTOMER_FALLBACK]);
  });

  it('closing another fold keeps the customer where it is', () => {
    expect(play('cut', [[{ kind: 'folds' }, { open: ['cut'], spy: 'cut' }]])).toEqual(['cut']);
  });

  it('above the first section (no section under the line) keeps the last one', () => {
    expect(play('details', [[{ kind: 'spy', key: null }, { spy: null }]])).toEqual(['details']);
  });
});
