// Hook for managing Excel range selection

import { useState, useCallback, useMemo } from 'react';
import type { SelectionRange, NormalizedRange, CellPosition } from '../types/importTypes';

export interface UseRangeSelectionReturn {
  // State
  ranges: SelectionRange[];
  activeRangeId: string | null;
  isSelecting: boolean;
  currentSelection: SelectionRange | null;

  // Actions
  startSelection: (row: number, col: number) => void;
  updateSelection: (row: number, col: number) => void;
  endSelection: () => void;
  addRange: (range?: SelectionRange) => void;
  removeRange: (id: string) => void;
  clearRanges: () => void;
  setActiveRange: (id: string | null) => void;

  // Helpers
  isInRange: (row: number, col: number) => boolean;
  getRangeForCell: (row: number, col: number) => SelectionRange | null;
  normalizeRange: (range: SelectionRange) => NormalizedRange;
}

const RANGE_COLORS = [
  'rgba(24, 144, 255, 0.2)',   // Blue
  'rgba(82, 196, 26, 0.2)',    // Green
  'rgba(250, 173, 20, 0.2)',   // Yellow
  'rgba(245, 34, 45, 0.2)',    // Red
  'rgba(114, 46, 209, 0.2)',   // Purple
];

let rangeIdCounter = 0;
const generateRangeId = (): string => `range_${++rangeIdCounter}_${Date.now()}`;

/**
 * Hook for managing range selection in Excel grid
 */
export const useRangeSelection = (): UseRangeSelectionReturn => {
  const [ranges, setRanges] = useState<SelectionRange[]>([]);
  const [activeRangeId, setActiveRangeId] = useState<string | null>(null);
  const [isSelecting, setIsSelecting] = useState(false);
  const [selectionStart, setSelectionStart] = useState<CellPosition | null>(null);
  const [selectionEnd, setSelectionEnd] = useState<CellPosition | null>(null);

  /**
   * Current selection being made (before it's finalized)
   */
  const currentSelection = useMemo((): SelectionRange | null => {
    if (!isSelecting || !selectionStart || !selectionEnd) {
      return null;
    }

    return {
      id: 'current',
      startRow: selectionStart.row,
      endRow: selectionEnd.row,
      startCol: selectionStart.col,
      endCol: selectionEnd.col,
      color: RANGE_COLORS[ranges.length % RANGE_COLORS.length],
    };
  }, [isSelecting, selectionStart, selectionEnd, ranges.length]);

  /**
   * Normalize a range so that start <= end
   */
  const normalizeRange = useCallback((range: SelectionRange): NormalizedRange => {
    return {
      minRow: Math.min(range.startRow, range.endRow),
      maxRow: Math.max(range.startRow, range.endRow),
      minCol: Math.min(range.startCol, range.endCol),
      maxCol: Math.max(range.startCol, range.endCol),
    };
  }, []);

  /**
   * Check if a cell is within any saved range
   */
  const isInRange = useCallback((row: number, col: number): boolean => {
    // Check saved ranges
    for (const range of ranges) {
      const { minRow, maxRow, minCol, maxCol } = normalizeRange(range);
      if (row >= minRow && row <= maxRow && col >= minCol && col <= maxCol) {
        return true;
      }
    }

    // Check current selection
    if (currentSelection) {
      const { minRow, maxRow, minCol, maxCol } = normalizeRange(currentSelection);
      if (row >= minRow && row <= maxRow && col >= minCol && col <= maxCol) {
        return true;
      }
    }

    return false;
  }, [ranges, currentSelection, normalizeRange]);

  /**
   * Get the range containing a specific cell
   */
  const getRangeForCell = useCallback((row: number, col: number): SelectionRange | null => {
    // Check current selection first
    if (currentSelection) {
      const { minRow, maxRow, minCol, maxCol } = normalizeRange(currentSelection);
      if (row >= minRow && row <= maxRow && col >= minCol && col <= maxCol) {
        return currentSelection;
      }
    }

    // Check saved ranges
    for (const range of ranges) {
      const { minRow, maxRow, minCol, maxCol } = normalizeRange(range);
      if (row >= minRow && row <= maxRow && col >= minCol && col <= maxCol) {
        return range;
      }
    }

    return null;
  }, [ranges, currentSelection, normalizeRange]);

  /**
   * Start a new selection
   */
  const startSelection = useCallback((row: number, col: number): void => {
    setIsSelecting(true);
    setSelectionStart({ row, col });
    setSelectionEnd({ row, col });
  }, []);

  /**
   * Update the current selection endpoint
   */
  const updateSelection = useCallback((row: number, col: number): void => {
    if (!isSelecting) return;
    setSelectionEnd({ row, col });
  }, [isSelecting]);

  /**
   * End the current selection and save it as a range
   */
  const endSelection = useCallback((): void => {
    if (!isSelecting || !selectionStart || !selectionEnd) {
      setIsSelecting(false);
      return;
    }

    // Create new range
    const newRange: SelectionRange = {
      id: generateRangeId(),
      startRow: selectionStart.row,
      endRow: selectionEnd.row,
      startCol: selectionStart.col,
      endCol: selectionEnd.col,
      color: RANGE_COLORS[ranges.length % RANGE_COLORS.length],
    };

    // Only add if range has size (not a single click without drag)
    const normalized = normalizeRange(newRange);
    const hasSize = normalized.maxRow > normalized.minRow || normalized.maxCol > normalized.minCol;

    if (hasSize) {
      setRanges(prev => [...prev, newRange]);
      setActiveRangeId(newRange.id);
    }

    setIsSelecting(false);
    setSelectionStart(null);
    setSelectionEnd(null);
  }, [isSelecting, selectionStart, selectionEnd, ranges.length, normalizeRange]);

  /**
   * Add a range manually
   */
  const addRange = useCallback((range?: SelectionRange): void => {
    if (range) {
      const newRange = {
        ...range,
        id: range.id || generateRangeId(),
        color: range.color || RANGE_COLORS[ranges.length % RANGE_COLORS.length],
      };
      setRanges(prev => [...prev, newRange]);
      setActiveRangeId(newRange.id);
    }
  }, [ranges.length]);

  /**
   * Remove a range by ID
   */
  const removeRange = useCallback((id: string): void => {
    setRanges(prev => prev.filter(r => r.id !== id));
    if (activeRangeId === id) {
      setActiveRangeId(null);
    }
  }, [activeRangeId]);

  /**
   * Clear all ranges
   */
  const clearRanges = useCallback((): void => {
    setRanges([]);
    setActiveRangeId(null);
    setIsSelecting(false);
    setSelectionStart(null);
    setSelectionEnd(null);
  }, []);

  /**
   * Set the active range
   */
  const setActiveRange = useCallback((id: string | null): void => {
    setActiveRangeId(id);
  }, []);

  return {
    ranges,
    activeRangeId,
    isSelecting,
    currentSelection,
    startSelection,
    updateSelection,
    endSelection,
    addRange,
    removeRange,
    clearRanges,
    setActiveRange,
    isInRange,
    getRangeForCell,
    normalizeRange,
  };
};
