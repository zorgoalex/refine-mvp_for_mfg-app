import React, { useCallback, useEffect } from 'react';
import { getOrderDraftStore } from '../../stores/orderFormStore';
import { clientScreenFrameNodeKey } from './clientScreenFrameSource';
import { clearOrderTabMirror, publishOrderTabMirror } from './orderTabMirror';
import type { ClientScreenFrameTabKey } from './clientScreenSnapshotSchema';

/**
 * Marks the area of an order form tab that the customer screen may show whole (cut, workshops,
 * additional). It is a plain block around the tab's own content and only says where that content
 * is; the tab itself is not changed and does not know about the customer screen.
 */
export const ClientScreenFrameSlot: React.FC<{ orderKey: string; tab: ClientScreenFrameTabKey; children: React.ReactNode }> = ({ orderKey, tab, children }) => {
  const place = useCallback((element: HTMLDivElement | null) => {
    try {
      const store = getOrderDraftStore(orderKey);
      if (element) publishOrderTabMirror(store, clientScreenFrameNodeKey(tab), element);
      else clearOrderTabMirror(store, clientScreenFrameNodeKey(tab));
    } catch {
      // the customer screen never stands in the way of the tab
    }
  }, [orderKey, tab]);
  useEffect(() => () => {
    try {
      clearOrderTabMirror(getOrderDraftStore(orderKey), clientScreenFrameNodeKey(tab));
    } catch {
      // nothing to clear
    }
  }, [orderKey, tab]);
  return <div ref={place} data-client-screen-frame={tab}>{children}</div>;
};
