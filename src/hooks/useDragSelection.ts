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

  // Auto-scroll
  const autoScrollRef = useRef<number | null>(null);
  const lastMouseYRef = useRef<number>(0);

  // Build key-to-index map for quick lookups
  const keyToIndexMap = useRef<Map<React.Key, number>>(new Map());

  useEffect(() => {
    keyToIndexMap.current.clear();
    items.forEach((item, index) => {
      keyToIndexMap.current.set(getRowKey(item), index);
    });
  }, [items, getRowKey]);

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

    // Check if mouse is near top or bottom edge
    const distanceFromTop = mouseY - rect.top;
    const distanceFromBottom = rect.bottom - mouseY;

    let scrollDelta = 0;

    if (distanceFromTop < autoScrollZone && distanceFromTop > 0) {
      // Near top - scroll up
      scrollDelta = -autoScrollSpeed * (1 - distanceFromTop / autoScrollZone);
    } else if (distanceFromBottom < autoScrollZone && distanceFromBottom > 0) {
      // Near bottom - scroll down
      scrollDelta = autoScrollSpeed * (1 - distanceFromBottom / autoScrollZone);
    }

    if (scrollDelta !== 0) {
      container.scrollTop += scrollDelta;
    }

    // Continue animation
    autoScrollRef.current = requestAnimationFrame(performAutoScroll);
  }, [scrollContainerRef, isDragging, autoScrollZone, autoScrollSpeed]);

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
      lastMouseYRef.current = e.clientY;
    };

    const handleGlobalMouseUp = () => {
      if (isDragging) {
        setIsDragging(false);
        // Don't clear pending - wait for confirmation
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
  }, [isDragging]);

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
    setEndIndex(index);
    lastMouseYRef.current = event.clientY;

    // Set initial pending selection
    setPendingKeys([rowKey]);
  }, []);

  // Handle mouse enter on row - extend selection
  const handleMouseEnter = useCallback((rowKey: React.Key) => {
    if (!isDragging || startIndex === null) return;

    const index = keyToIndexMap.current.get(rowKey);
    if (index === undefined) return;

    setEndIndex(index);

    // Calculate new pending keys
    const newPendingKeys = calculatePendingKeys(startIndex, index);
    setPendingKeys(newPendingKeys);
  }, [isDragging, startIndex, calculatePendingKeys]);

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
  }, [pendingKeys, selectedKeys, onSelectionChange]);

  // Cancel pending selection
  const cancelSelection = useCallback(() => {
    setPendingKeys([]);
    setStartIndex(null);
    setEndIndex(null);
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
