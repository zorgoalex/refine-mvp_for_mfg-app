// Range drafts use refs so pointerup commits the last coordinates, even in a batched render.
import { useState, useCallback, useRef } from 'react';
import type { SelectionRange, NormalizedRange } from '../types/importTypes';
import { moveRange } from '../steps/excelGridGeometry';

const RANGE_COLORS = ['rgba(24, 144, 255, 0.2)', 'rgba(82, 196, 26, 0.2)', 'rgba(250, 173, 20, 0.2)'];
let rangeId = 0;
const normalizeRange = (range: SelectionRange): NormalizedRange => ({
  minRow: Math.min(range.startRow, range.endRow), maxRow: Math.max(range.startRow, range.endRow),
  minCol: Math.min(range.startCol, range.endCol), maxCol: Math.max(range.startCol, range.endCol),
});

export const useRangeSelection = (rowCount = Infinity, colCount = Infinity) => {
  const [ranges, setRanges] = useState<SelectionRange[]>([]);
  const [activeRangeId, setActiveRangeId] = useState<string | null>(null);
  const [currentSelection, setCurrentSelection] = useState<SelectionRange | null>(null);
  const draft = useRef<SelectionRange | null>(null);
  const moving = useRef<{ range: SelectionRange; row: number; col: number } | null>(null);
  const rangesRef = useRef(ranges);
  rangesRef.current = ranges;

  const cancelSelection = useCallback(() => {
    draft.current = null;
    moving.current = null;
    setCurrentSelection(null);
  }, []);

  const startSelection = useCallback((row: number, col: number, moveId?: string) => {
    const original = rangesRef.current.find(range => range.id === moveId);
    moving.current = original ? { range: original, row, col } : null;
    draft.current = original ? { ...original } : {
      id: 'current', startRow: row, endRow: row, startCol: col, endCol: col,
      color: RANGE_COLORS[rangesRef.current.length % RANGE_COLORS.length],
    };
    setCurrentSelection(draft.current);
  }, []);

  const updateSelection = useCallback((row: number, col: number) => {
    if (!draft.current) return;
    const move = moving.current;
    const next = move ? moveRange(move.range, row - move.row, col - move.col, rowCount, colCount)
      : { ...draft.current, endRow: row, endCol: col };
    if (Object.keys(next).every(key => next[key as keyof SelectionRange] === draft.current?.[key as keyof SelectionRange])) return;
    draft.current = next;
    setCurrentSelection(next);
  }, [rowCount, colCount]);

  const endSelection = useCallback(() => {
    const selected = draft.current;
    const move = moving.current;
    if (!selected) return;
    cancelSelection();
    if (selected.startRow === selected.endRow && selected.startCol === selected.endCol && !move) return;
    const committed = { ...selected, id: move ? move.range.id : `range_${++rangeId}_${Date.now()}` };
    setRanges(previous => move ? previous.map(range => range.id === move.range.id ? committed : range) : [...previous, committed]);
    setActiveRangeId(committed.id);
  }, [cancelSelection]);

  const addRange = useCallback((range?: SelectionRange) => {
    if (!range) return;
    const next = { ...range, id: range.id || `range_${++rangeId}_${Date.now()}`, color: range.color || RANGE_COLORS[0] };
    setRanges(previous => [...previous, next]);
    setActiveRangeId(next.id);
  }, []);
  const removeRange = useCallback((id: string) => {
    setRanges(previous => previous.filter(range => range.id !== id));
    setActiveRangeId(previous => previous === id ? null : previous);
  }, []);
  const clearRanges = useCallback(() => {
    cancelSelection();
    setRanges([]);
    setActiveRangeId(null);
  }, [cancelSelection]);
  const getRangeForCell = useCallback((row: number, col: number) => {
    for (const range of [currentSelection, ...ranges.filter(range => range.id !== currentSelection?.id)]) {
      if (!range) continue;
      const bounds = normalizeRange(range);
      if (row >= bounds.minRow && row <= bounds.maxRow && col >= bounds.minCol && col <= bounds.maxCol) return range;
    }
    return null;
  }, [currentSelection, ranges]);
  const isInRange = useCallback((row: number, col: number) => !!getRangeForCell(row, col), [getRangeForCell]);
  return { ranges, activeRangeId, isSelecting: currentSelection !== null, currentSelection,
    startSelection, updateSelection, endSelection, cancelSelection, addRange, removeRange, clearRanges,
    setActiveRange: setActiveRangeId, isInRange, getRangeForCell, normalizeRange };
};
export type UseRangeSelectionReturn = ReturnType<typeof useRangeSelection>;
