import React, { type ReactNode } from 'react';

interface PopconfirmContentProps {
  title: ReactNode;
  description: ReactNode;
}

// AntD 5.0 does not render Popconfirm.description. Keep both texts in its title;
// the native Popconfirm still owns triggers, focus, cancellation and async actions.
export function PopconfirmContent({ title, description }: PopconfirmContentProps) {
  return (
    <div style={{ maxWidth: 'min(320px, calc(100vw - 80px))', whiteSpace: 'normal', overflowWrap: 'anywhere' }}>
      <div style={{ fontWeight: 600, textWrap: 'balance' }}>{title}</div>
      <div style={{ marginTop: 4, fontWeight: 400, textWrap: 'pretty' }}>{description}</div>
    </div>
  );
}
