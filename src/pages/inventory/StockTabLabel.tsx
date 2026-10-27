import React from 'react';

/**
 * Tab label «Плёнка · 83»: the count is a separate element, so «NewLine» shows it as a plate (mockup 13);
 * other variants keep the text «Плёнка · 83» as it was.
 */
export function splitStockTabLabel(label: string): { name: string; count: string | null } {
  const match = /^(.*) · (\d+)$/.exec(label);
  return match ? { name: match[1], count: match[2] } : { name: label, count: null };
}

export const StockTabLabel: React.FC<{ label: string }> = ({ label }) => {
  const { name, count } = splitStockTabLabel(label);
  if (count === null) return <>{label}</>;
  return (
    <>
      {name}
      <span className="stock-tab-count"><span className="stock-tab-count__sep"> · </span>{count}</span>
    </>
  );
};

export function stockTabItems<T extends { key: string; label: string }>(tabs: T[]): Array<{ key: string; label: React.ReactNode }> {
  return tabs.map((tab) => ({ key: tab.key, label: <StockTabLabel label={tab.label} /> }));
}
