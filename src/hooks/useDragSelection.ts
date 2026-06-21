// Hook for drag selection of table rows
// Allows selecting multiple rows by clicking and dragging vertically
// Features: auto-scroll near edges, pending selection with confirmation

import { useState, useCallback, useRef, useEffect } from 'react';

export interface UseDragSelectionOptions<T> {
  /** Array of items (rows) */
  items: T[];
  /** Function to get unique key from item */
  getRowKey: (item: T) => React.Key;
  /** Currently selected keys (from parent) */
  selectedKeys: React.Key[];
  /** Callback when selection changes (after confirmation) */
  onSelectionChange: (keys: React.Key[]) => void;
  /** Scroll container ref for auto-scroll (can be RefObject or MutableRefObject) */
  scrollContainerRef?: React.RefObject<HTMLElement | null> | React.MutableRefObject<HTMLElement | null>;
  /** Auto-scroll zone size in pixels (default: 50) */
  autoScrollZone?: number;
  /** Auto-scroll speed in pixels per frame (default: 8) */
  autoScrollSpeed?: number;
}

export interface UseDragSelectionReturn {
  /** Is currently dragging */
  isDragging: boolean;
  /** Keys pending selection (not yet confirmed) */
  pendingKeys: React.Key[];
  /** Whether there are pending selections to confirm */
  hasPendingSelection: boolean;
  /** Start drag from a row */
  handleMouseDown: (rowKey: React.Key, event: React.MouseEvent) => void;
  /** Continue drag over a row */
  handleMouseEnter: (rowKey: React.Key) => void;
  /** Confirm pending selection */
  confirmSelection: () => void;
  /** Cancel pending selection */
  cancelSelection: () => void;
  /** Check if row is in pending selection */
  isInPendingSelection: (rowKey: React.Key) => boolean;
  /** Get row class name for styling */
  getRowClassName: (rowKey: React.Key) => string;
}

export function useDragSelection<T>({
  items,
  getRowKey,
  selectedKeys,
  onSelectionChange,
  scrollContainerRef,
  autoScrollZone = 50,
  autoScrollSpeed = 8,
}: UseDragSelectionOptions<T>): UseDragSelectionReturn {
  // Drag state
  const [isDragging, setIsDragging] = useState(false);
  const [startIndex, setStartIndex] = useState<number | null>(null);
  const [endIndex, setEndIndex] = useState<number | null>(null);
  const [pendingKeys, setPendingKeys] = useState<React.Key[]>([]);
  const startIndexRef = useRef<number | null>(null);
  const isDraggingRef = useRef(false);
  const pendingKeysRef = useRef<React.Key[]>([]);

  // Auto-scroll
  const autoScrollRef = useRef<number | null>(null);
  const lastMouseXRef = useRef<number>(0);
  const lastMouseYRef = useRef<number>(0);

  // Build key-to-index map for quick lookups
  const keyToIndexMap = useRef<Map<React.Key, number>>(new Map());
  const domKeyToRowKeyMap = useRef<Map<string, React.Key>>(new Map());

  useEffect(() => {
    keyToIndexMap.current.clear();
    domKeyToRowKeyMap.current.clear();
    items.forEach((item, index) => {
      const rowKey = getRowKey(item);
      keyToIndexMap.current.set(rowKey, index);
      domKeyToRowKeyMap.current.set(String(rowKey), rowKey);
    });
  }, [items, getRowKey]);

  useEffect(() => {
    isDraggingRef.current = isDragging;
  }, [isDragging]);

  useEffect(() => {
    pendingKeysRef.current = pendingKeys;
  }, [pendingKeys]);

  // Calculate pending keys based on start/end indices
  const calculatePendingKeys = useCallback((start: number, end: number): React.Key[] => {
    const minIndex = Math.min(start, end);
    const maxIndex = Math.max(start, end);

    const keys: React.Key[] = [];
    for (let i = minIndex; i <= maxIndex; i++) {
      if (i >= 0 && i < items.length) {
        keys.push(getRowKey(items[i]));
      }
    }
    return keys;
  }, [items, getRowKey]);

  const updatePendingToIndex = useCallback((index: number) => {
    const dragStartIndex = startIndexRef.current ?? startIndex;
    if (!isDraggingRef.current || dragStartIndex === null) return;

    if (index === dragStartIndex) {
      setEndIndex(index);
      setPendingKeys([]);
      return;
    }

    setEndIndex(index);
    setPendingKeys(calculatePendingKeys(dragStartIndex, index));
  }, [calculatePendingKeys, startIndex]);

  const updatePendingFromPoint = useCallback((x: number, y: number) => {
    const element = document.elementFromPoint(x, y);
    const row = element?.closest?.('tr[data-row-key]');
    const domKey = row?.getAttribute('data-row-key');
    if (!domKey) return;

    const rowKey = domKeyToRowKeyMap.current.get(domKey);
    if (rowKey === undefined) return;

    const index = keyToIndexMap.current.get(rowKey);
    if (index === undefined) return;

    updatePendingToIndex(index);
  }, [updatePendingToIndex]);

  // Auto-scroll logic
  const performAutoScroll = useCallback(() => {
    if (!scrollContainerRef?.current || !isDragging) {
      if (autoScrollRef.current) {
        cancelAnimationFrame(autoScrollRef.current);
        autoScrollRef.current = null;
      }
      return;
    }

    const container = scrollContainerRef.current;
    const rect = container.getBoundingClientRect();
    const mouseY = lastMouseYRef.current;

    let scrollDelta = 0;

    if (mouseY <= rect.top + autoScrollZone) {
      const distanceFromTop = Math.max(mouseY - rect.top, 0);
      scrollDelta = -autoScrollSpeed * (1 - distanceFromTop / autoScrollZone);
    } else if (mouseY >= rect.bottom - autoScrollZone) {
      const distanceFromBottom = Math.max(rect.bottom - mouseY, 0);
      scrollDelta = autoScrollSpeed * (1 - distanceFromBottom / autoScrollZone);
    }

    if (scrollDelta !== 0) {
      container.scrollTop += scrollDelta;
      updatePendingFromPoint(
        Math.min(Math.max(lastMouseXRef.current, rect.left + 1), rect.right - 1),
        Math.min(Math.max(mouseY, rect.top + 1), rect.bottom - 1)
      );
    }

    // Continue animation
    autoScrollRef.current = requestAnimationFrame(performAutoScroll);
  }, [scrollContainerRef, isDragging, autoScrollZone, autoScrollSpeed, updatePendingFromPoint]);

  // Start auto-scroll when dragging starts
  useEffect(() => {
    if (isDragging) {
      autoScrollRef.current = requestAnimationFrame(performAutoScroll);
    } else {
      if (autoScrollRef.current) {
        cancelAnimationFrame(autoScrollRef.current);
        autoScrollRef.current = null;
      }
    }

    return () => {
      if (autoScrollRef.current) {
        cancelAnimationFrame(autoScrollRef.current);
        autoScrollRef.current = null;
      }
    };
  }, [isDragging, performAutoScroll]);

  // Global mouse move/up handlers
  useEffect(() => {
    const handleGlobalMouseMove = (e: MouseEvent) => {
      if (!isDragging) return;
      lastMouseXRef.current = e.clientX;
      lastMouseYRef.current = e.clientY;
      updatePendingFromPoint(e.clientX, e.clientY);
    };

    const handleGlobalMouseUp = () => {
      if (isDragging) {
        setIsDragging(false);
        if (pendingKeysRef.current.length === 0) {
          setStartIndex(null);
          setEndIndex(null);
          startIndexRef.current = null;
        }
        // Keep non-empty pending selection until confirmation/cancel.
      }
    };

    if (isDragging) {
      document.addEventListener('mousemove', handleGlobalMouseMove);
      document.addEventListener('mouseup', handleGlobalMouseUp);
    }

    return () => {
      document.removeEventListener('mousemove', handleGlobalMouseMove);
      document.removeEventListener('mouseup', handleGlobalMouseUp);
    };
  }, [isDragging, updatePendingFromPoint]);

  // Handle mouse down on row - start drag
  const handleMouseDown = useCallback((rowKey: React.Key, event: React.MouseEvent) => {
    // Only left mouse button
    if (event.button !== 0) return;

    // Don't interfere with checkbox clicks or other interactive elements
    const target = event.target as HTMLElement;
    if (
      target.closest('.ant-checkbox-wrapper') ||
      target.closest('.ant-btn') ||
      target.closest('.ant-select') ||
      target.closest('.ant-input') ||
      target.closest('.ant-input-number') ||
      target.closest('input') ||
      target.closest('button')
    ) {
      return;
    }

    const index = keyToIndexMap.current.get(rowKey);
    if (index === undefined) return;

    event.preventDefault();

    setIsDragging(true);
    setStartIndex(index);
    startIndexRef.current = index;
    setEndIndex(index);
    lastMouseXRef.current = event.clientX;
    lastMouseYRef.current = event.clientY;

    // Do not create a one-row pending selection on mouse down. Double-click
    // starts with two mouse downs and must not look like drag selection.
    setPendingKeys([]);
  }, []);

  // Handle mouse enter on row - extend selection
  const handleMouseEnter = useCallback((rowKey: React.Key) => {
    const index = keyToIndexMap.current.get(rowKey);
    if (index === undefined) return;
    updatePendingToIndex(index);
  }, [updatePendingToIndex]);

  // Confirm pending selection - merge with existing
  const confirmSelection = useCallback(() => {
    if (pendingKeys.length === 0) return;

    // Merge pending keys with existing selection (toggle behavior)
    const newSelectedKeys = new Set(selectedKeys);

    pendingKeys.forEach(key => {
      if (newSelectedKeys.has(key)) {
        // If already selected, deselect (toggle)
        newSelectedKeys.delete(key);
      } else {
        // If not selected, select
        newSelectedKeys.add(key);
      }
    });

    onSelectionChange(Array.from(newSelectedKeys));

    // Clear pending
    setPendingKeys([]);
    setStartIndex(null);
    setEndIndex(null);
    startIndexRef.current = null;
  }, [pendingKeys, selectedKeys, onSelectionChange]);

  // Cancel pending selection
  const cancelSelection = useCallback(() => {
    setPendingKeys([]);
    setStartIndex(null);
    setEndIndex(null);
    startIndexRef.current = null;
    setIsDragging(false);
  }, []);

  // Check if row is in pending selection
  const isInPendingSelection = useCallback((rowKey: React.Key): boolean => {
    return pendingKeys.includes(rowKey);
  }, [pendingKeys]);

  // Get row class name for styling
  const getRowClassName = useCallback((rowKey: React.Key): string => {
    const classes: string[] = [];

    if (isInPendingSelection(rowKey)) {
      classes.push('drag-selection-pending');
    }

    if (selectedKeys.includes(rowKey)) {
      classes.push('drag-selection-selected');
    }

    return classes.join(' ');
  }, [isInPendingSelection, selectedKeys]);

  return {
    isDragging,
    pendingKeys,
    hasPendingSelection: pendingKeys.length > 0,
    handleMouseDown,
    handleMouseEnter,
    confirmSelection,
    cancelSelection,
    isInPendingSelection,
    getRowClassName,
  };
}
