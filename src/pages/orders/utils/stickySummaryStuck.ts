// Pure hysteresis helper for the sticky order summary header.
//
// Without hysteresis, collapsing the header on "stuck" shrinks the in-flow
// sticky wrapper, which shifts window.scrollY (scroll clamp / scroll
// anchoring). That shift can move the sentinel back below the stick
// threshold, unsticking the header, which grows it back, which shifts the
// scroll again, and so on every animation frame. Once stuck, we tolerate a
// sentinel offset up to the height the collapse itself could have caused, so
// the collapse can never unstick the header on its own; scrolling up past
// the band still unsticks it normally.
export interface ResolveStickySummaryStuckInput {
  enabled: boolean;
  wasStuck: boolean;
  sentinelTop: number | null; // null = no sentinel node
  stickyTop: number; // workspaceTabsHeight
  expandedHeight: number; // last measured wrapper height while NOT stuck (0 if unknown)
  currentHeight: number; // current wrapper height
}

const SUBPIXEL_TOLERANCE_PX = 1;

export function resolveStickySummaryStuck(input: ResolveStickySummaryStuckInput): boolean {
  const { enabled, wasStuck, sentinelTop, stickyTop, expandedHeight, currentHeight } = input;

  if (!enabled || sentinelTop == null) return false;

  if (!wasStuck) {
    return sentinelTop <= stickyTop;
  }

  const collapseDelta = Math.max(0, expandedHeight - currentHeight);
  return sentinelTop <= stickyTop + collapseDelta + SUBPIXEL_TOLERANCE_PX;
}
