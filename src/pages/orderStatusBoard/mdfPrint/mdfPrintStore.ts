// «NewLine»: print of the MDF board. The toolbar button opens the dialog; the board columns component renders the
// dialog (it has the columns on screen) and, while printing, the printed sheet of the chosen columns.
import { useSyncExternalStore } from 'react';

export type MdfPrintPaper = 'A4' | 'A3';

export interface MdfPrintState {
  open: boolean;
  /** the print sheet of the chosen columns is mounted in <body> */
  printing: boolean;
  paper: MdfPrintPaper;
  /** chosen column keys; null — every column on screen */
  columnKeys: readonly string[] | null;
  /** grows when the dialog closes: the board re-mounts its lazy cards so they are lazy again after printing */
  generation: number;
}

const PAPER_STORAGE_KEY = 'erp.mdfBoard.printPaper';

const readPaper = (): MdfPrintPaper => {
  try {
    return window.localStorage.getItem(PAPER_STORAGE_KEY) === 'A3' ? 'A3' : 'A4';
  } catch {
    return 'A4';
  }
};

let state: MdfPrintState = { open: false, printing: false, paper: 'A4', columnKeys: null, generation: 0 };
const listeners = new Set<() => void>();

function set(next: Partial<MdfPrintState>): void {
  state = { ...state, ...next };
  listeners.forEach((listener) => listener());
}

export const mdfPrint = {
  get: (): MdfPrintState => state,
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  open(): void {
    set({ open: true, printing: false, paper: readPaper(), columnKeys: null });
  },
  close(): void {
    set({ open: false, printing: false, generation: state.generation + 1 });
  },
  setPaper(paper: MdfPrintPaper): void {
    try {
      window.localStorage.setItem(PAPER_STORAGE_KEY, paper);
    } catch {
      // only a convenience
    }
    set({ paper });
  },
  setColumnKeys(columnKeys: readonly string[] | null): void {
    set({ columnKeys });
  },
  setPrinting(printing: boolean): void {
    set({ printing });
  },
};

export function useMdfPrintState(): MdfPrintState {
  return useSyncExternalStore(mdfPrint.subscribe, mdfPrint.get, mdfPrint.get);
}

/** The columns to print: the chosen ones in screen order (unknown keys are ignored). */
export function chosenMdfPrintColumns<T extends { key: string }>(columns: readonly T[], columnKeys: readonly string[] | null): T[] {
  if (!columnKeys) return [...columns];
  const chosen = new Set(columnKeys);
  return columns.filter((column) => chosen.has(column.key));
}
