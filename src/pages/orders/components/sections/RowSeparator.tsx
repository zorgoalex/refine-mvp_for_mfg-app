import React from 'react';

// Module-level pure separator (was previously redefined inside each header
// component on every render). Closes over nothing.
export const RowSeparator: React.FC = () => (
  <div style={{ height: 1, background: '#E5E7EB', margin: 0 }} />
);
