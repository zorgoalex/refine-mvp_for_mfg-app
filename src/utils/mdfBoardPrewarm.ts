export const MDF_BOARD_SNAPSHOT_READY_EVENT = 'erp:mdf-board-snapshot-ready';

let mdfBoardSnapshotReady = false;

export function markMdfBoardSnapshotReady(): void {
  mdfBoardSnapshotReady = true;
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(MDF_BOARD_SNAPSHOT_READY_EVENT));
  }
}

export function isMdfBoardSnapshotReady(): boolean {
  return mdfBoardSnapshotReady;
}
