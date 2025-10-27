import { useEffect, useRef } from "react";
import { useSearchParams } from "react-router-dom";

/**
 * Hook for highlighting and scrolling to a specific table row after create/edit
 * Usage:
 * const { highlightProps } = useHighlightRow();
 * <Table {...tableProps} {...highlightProps} />
 */
export const useHighlightRow = (idField: string = "id") => {
  const [searchParams, setSearchParams] = useSearchParams();
  const highlightId = searchParams.get("highlightId");
  const highlightedRowRef = useRef<HTMLTableRowElement | null>(null);

  useEffect(() => {
    if (highlightId && highlightedRowRef.current) {
      highlightedRowRef.current.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
      // Remove highlightId from URL after animation
      const timer = setTimeout(() => {
        searchParams.delete("highlightId");
        setSearchParams(searchParams, { replace: true });
      }, 2000);

      return () => clearTimeout(timer);
    }
  }, [highlightId, searchParams, setSearchParams]);

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
