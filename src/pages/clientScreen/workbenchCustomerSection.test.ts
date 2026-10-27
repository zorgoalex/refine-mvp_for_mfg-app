import { describe, expect, it } from 'vitest';
import {
  nextWorkbenchCustomerSection,
  workbenchCustomerEvents,
  type WorkbenchCustomerInputs,
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

/** Commits of the form, as the hook sees them: each one turned into events and applied in order. */
function commits(open: (inputs: WorkbenchCustomerInputs) => string[], steps: WorkbenchCustomerInputs[]) {
  let previous: WorkbenchCustomerInputs | null = null;
  let section = steps[0].activeTab;
  const seen: string[] = [];
  for (const next of steps) {
    const openNow = open(next);
    const context = { pinned: next.pinned, spy: next.spy, isOpen: (key: string) => MAIN.includes(key) || openNow.includes(key) };
    for (const event of workbenchCustomerEvents(previous, next)) section = nextWorkbenchCustomerSection(section, event, context);
    previous = next;
    seen.push(section);
  }
  return seen;
}
const folds = (inputs: WorkbenchCustomerInputs) => (inputs.foldsKey ? inputs.foldsKey.split(',') : []);

describe('NewLine: what one commit of the form brings', () => {
  it('a commit that changes nothing brings nothing', () => {
    const inputs = { activeTab: 'details', pinned: null, spy: 'details', foldsKey: '', navigationSeq: 3 };
    expect(workbenchCustomerEvents(inputs, { ...inputs })).toEqual([]);
  });

  it('a navigation to the section already current is still a navigation', () => {
    const inputs = { activeTab: 'hdf', pinned: 'hdf', spy: 'details', foldsKey: 'hdf', navigationSeq: 3 };
    expect(workbenchCustomerEvents(inputs, { ...inputs, navigationSeq: 4 })).toEqual([{ kind: 'navigate', key: 'hdf' }]);
  });

  it('anchor to a fold → the fold closed → reopened by its heading: the customer is back on it', () => {
    expect(commits(folds, [
      { activeTab: 'details', pinned: null, spy: 'details', foldsKey: '', navigationSeq: 0 },
      // anchor «ХДФ»: opened, current, pinned
      { activeTab: 'hdf', pinned: 'hdf', spy: 'details', foldsKey: 'hdf', navigationSeq: 1 },
      { activeTab: 'hdf', pinned: 'hdf', spy: 'hdf', foldsKey: 'hdf', navigationSeq: 1 },
      // closed by its heading: the pin goes with it, the open section in view takes its place
      { activeTab: 'hdf', pinned: null, spy: 'finance', foldsKey: '', navigationSeq: 1 },
      // reopened by its heading: same activeTab, a new navigation
      { activeTab: 'hdf', pinned: null, spy: 'finance', foldsKey: 'hdf', navigationSeq: 2 },
    ])).toEqual(['details', 'hdf', 'hdf', 'finance', 'hdf']);
  });

  it('the same anchor clicked again after the fold was closed brings the customer back too', () => {
    expect(commits(folds, [
      { activeTab: 'hdf', pinned: 'hdf', spy: 'hdf', foldsKey: 'hdf', navigationSeq: 1 },
      { activeTab: 'hdf', pinned: null, spy: 'finance', foldsKey: '', navigationSeq: 1 },
      { activeTab: 'hdf', pinned: 'hdf', spy: 'finance', foldsKey: 'hdf', navigationSeq: 2 },
    ])).toEqual(['hdf', 'finance', 'hdf']);
  });

  it('a form under another workspace page gets no commits: the customer keeps its section', () => {
    // the form measures nothing while hidden, so its inputs do not change; back on it, the spy is fresh
    expect(commits(folds, [
      { activeTab: 'finance', pinned: null, spy: 'finance', foldsKey: '', navigationSeq: 0 },
      { activeTab: 'finance', pinned: null, spy: 'finance', foldsKey: '', navigationSeq: 0 },
    ])).toEqual(['finance', 'finance']);
  });
});
