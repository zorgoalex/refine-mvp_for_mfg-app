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

export interface WorkbenchCustomerInputs {
  activeTab: string;
  pinned: string | null;
  spy: string | null;
  /** Changes whenever the set of open folds changes. */
  foldsKey: string;
  /** Grows with every navigation the manager makes, also to the section already current. */
  navigationSeq: number;
}

/** The events one commit of the form brings, in the order they are applied. */
export function workbenchCustomerEvents(previous: WorkbenchCustomerInputs | null, next: WorkbenchCustomerInputs): WorkbenchCustomerEvent[] {
  const events: WorkbenchCustomerEvent[] = [];
  if (!previous || previous.spy !== next.spy) events.push({ kind: 'spy', key: next.spy });
  if (!previous || previous.pinned !== next.pinned) events.push({ kind: 'pin', key: next.pinned });
  // a navigation that also pins (anchor click) ends on its own key
  if (!previous || previous.activeTab !== next.activeTab || previous.navigationSeq !== next.navigationSeq) {
    events.push({ kind: 'navigate', key: next.activeTab });
  }
  if (!previous || previous.foldsKey !== next.foldsKey) events.push({ kind: 'folds' });
  return events;
}

/**
 * The customer's section of each order, kept outside the form: the workspace may rebuild a form it has
 * hidden (its own state starts over then), and the customer must not lose the section because of that.
 */
const sectionByOrder = new Map<string, string>();

export function useWorkbenchCustomerSection(input: WorkbenchCustomerInputs & {
  orderKey: string;
  /** False while the form is kept under another workspace page: nothing it reports then is the manager's. */
  active: boolean;
  isOpen: (key: string) => boolean;
}): string {
  const { orderKey, active, activeTab, pinned, spy, foldsKey, navigationSeq, isOpen } = input;
  const [section, setSection] = useState(() => sectionByOrder.get(orderKey) ?? activeTab);
  // A form rebuilt for an order the customer already follows starts from what it reports now, without
  // treating that as the manager's navigation.
  const previous = useRef<WorkbenchCustomerInputs | null>(
    sectionByOrder.has(orderKey) ? { activeTab, pinned, spy, foldsKey, navigationSeq } : null,
  );
  useEffect(() => {
    const next = { activeTab, pinned, spy, foldsKey, navigationSeq };
    const events = workbenchCustomerEvents(previous.current, next);
    previous.current = next;
    if (!active || events.length === 0) return;
    const context: WorkbenchCustomerContext = { pinned, spy, isOpen };
    setSection((current) => events.reduce((value, event) => nextWorkbenchCustomerSection(value, event, context), current));
  }, [active, activeTab, pinned, spy, foldsKey, navigationSeq, isOpen]);
  useEffect(() => {
    sectionByOrder.set(orderKey, section);
  }, [orderKey, section]);
  return section;
}
