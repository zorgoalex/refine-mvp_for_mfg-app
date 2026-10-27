import { useEffect, useRef } from 'react';
import { subscribeSessionGenerationChange } from '../../api/sessionGenerationChange';

/** A re-login or a permission/scope change drops what the board shows at once — also while it is hidden or a
 * background read is still running: `onReset(shown)` runs on every session generation change, and `shown` tells
 * whether the board is on screen (then it reads its data again under the new session). Reads started before the
 * change must compare their revision (`revisionRef`, bumped here) before applying a result. */
export function useSessionGenerationReset(params: {
  active: boolean;
  revisionRef: { current: number };
  onReset: (shown: boolean) => void;
}): void {
  const activeRef = useRef(params.active);
  activeRef.current = params.active;
  const onResetRef = useRef(params.onReset);
  onResetRef.current = params.onReset;
  const { revisionRef } = params;
  useEffect(() => subscribeSessionGenerationChange(() => {
    revisionRef.current += 1;
    onResetRef.current(activeRef.current);
  }), [revisionRef]);
}
