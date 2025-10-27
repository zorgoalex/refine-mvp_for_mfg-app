import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";

/**
 * Hook for highlighting and scrolling to a specific table row after create/edit
 * Usage:
 * const { highlightProps } = useHighlightRow("record_id", tableProps.dataSource);
 * <Table {...tableProps} {...highlightProps} />
 */
export const useHighlightRow = (idField: string = "id", dataSource?: any[]) => {
  const [searchParams, setSearchParams] = useSearchParams();
  const highlightId = searchParams.get("highlightId");
  const highlightedRowRef = useRef<HTMLTableRowElement | null>(null);
  const [shouldScroll, setShouldScroll] = useState(false);

  // Check if highlighted record is in current dataSource
  useEffect(() => {
    if (highlightId && dataSource) {
      if (dataSource.length === 0) {
        // Wait for data to load
        return;
      }
      const recordExists = dataSource.some(
        (record) => String(record[idField]) === highlightId
      );
      if (recordExists) {
        setShouldScroll(true);
      } else {
        // Record not on this page - still show the highlight ID was received
        console.log(`Record ${highlightId} not found on current page`);
      }
    }
  }, [highlightId, dataSource, idField]);

  // Scroll to highlighted row when it's rendered
  useEffect(() => {
    if (shouldScroll && highlightedRowRef.current) {
      // Small delay to ensure DOM is ready
      setTimeout(() => {
        highlightedRowRef.current?.scrollIntoView({
          behavior: "smooth",
          block: "center",
        });
      }, 100);

      // Remove highlightId from URL after animation
      const timer = setTimeout(() => {
        searchParams.delete("highlightId");
        setSearchParams(searchParams, { replace: true });
        setShouldScroll(false);
      }, 2500);

      return () => clearTimeout(timer);
    }
  }, [shouldScroll, searchParams, setSearchParams]);

  return {
    highlightProps: {
      rowClassName: (record: any) =>
        highlightId && String(record[idField]) === highlightId
          ? "highlighted-row"
          : "",
      onRow: (record: any) => ({
        ref:
          highlightId && String(record[idField]) === highlightId
            ? highlightedRowRef
            : undefined,
      }),
    },
  };
};
