import { useEffect, useRef, useState } from 'react';

/**
 * «NewLine» shows the order form as one page of sections: the customer follows the section the manager
 * is at. What moved the manager last decides:
 * - a navigation (anchor click, `?tab=`, save validation, Ctrl+Tab, a fold opened) — its section, even
 *   while an earlier anchor is still pinned;
 * - an anchor pinned — that section (a short last section never reaches the top, the pin stands for it);
 * - scrolling — the open section under the sticky rows, once no anchor is pinned (the pin ends with the
 *   manager's own wheel or touch scroll; then the customer goes where the page is);
 * - a fold closed — a closed section is never the customer's: the open section in view takes its place.
 */
export type WorkbenchCustomerEvent =
  | { kind: 'navigate'; key: string }
  | { kind: 'pin'; key: string | null }
  | { kind: 'spy'; key: string | null }
  | { kind: 'folds' };

export interface WorkbenchCustomerContext {
  pinned: string | null;
  /** The open section under the sticky rows (closed folds are skipped), null above the first one. */
  spy: string | null;
  isOpen: (key: string) => boolean;
}

/** Shown when the customer's section was closed and no open section is in view. */
export const WORKBENCH_CUSTOMER_FALLBACK = 'details';

export function nextWorkbenchCustomerSection(
  current: string,
  event: WorkbenchCustomerEvent,
  context: WorkbenchCustomerContext,
): string {
  switch (event.kind) {
    case 'navigate':
      return event.key;
    case 'pin':
      return event.key ?? context.spy ?? current;
    case 'spy':
      return context.pinned !== null || event.key === null ? current : event.key;
    case 'folds':
      if (context.isOpen(current)) return current;
      return context.spy !== null && context.isOpen(context.spy) ? context.spy : WORKBENCH_CUSTOMER_FALLBACK;
  }
}

export function useWorkbenchCustomerSection(input: {
  activeTab: string;
  pinned: string | null;
  spy: string | null;
  isOpen: (key: string) => boolean;
  /** Changes whenever the set of open folds changes. */
  foldsKey: string;
}): string {
  const [section, setSection] = useState(input.activeTab);
  const context = useRef<WorkbenchCustomerContext>(input);
  context.current = { pinned: input.pinned, spy: input.spy, isOpen: input.isOpen };
  const apply = (event: WorkbenchCustomerEvent) => (
    setSection((current) => nextWorkbenchCustomerSection(current, event, context.current))
  );
  // Effects run in this order within one commit: a navigation that also pins (anchor click) ends on its key.
  useEffect(() => { apply({ kind: 'spy', key: input.spy }); }, [input.spy]);
  useEffect(() => { apply({ kind: 'pin', key: input.pinned }); }, [input.pinned]);
  useEffect(() => { apply({ kind: 'navigate', key: input.activeTab }); }, [input.activeTab]);
  useEffect(() => { apply({ kind: 'folds' }); }, [input.foldsKey]);
  return section;
}
