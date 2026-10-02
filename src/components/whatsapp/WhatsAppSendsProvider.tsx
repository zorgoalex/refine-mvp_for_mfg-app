import React, { createContext, useContext } from 'react';
import type { MyWhatsAppSend } from '../../api/myWhatsAppSendsApi';
import { useMyWhatsAppSends } from './useMyWhatsAppSends';

interface WhatsAppSendsContextValue { items: MyWhatsAppSend[]; refresh: () => void; supported: boolean | null }

const WhatsAppSendsContext = createContext<WhatsAppSendsContextValue>({ items: [], refresh: () => undefined, supported: null });

/**
 * The single follower of the user's own WhatsApp sends and the balloon container. Mounted once in
 * the authenticated shell, so it works whatever the layout shows (the bell can be inside a closed
 * drawer on a tablet); unmounted on logout, which closes the balloons.
 */
export const WhatsAppSendsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { items, refresh, contextHolder, supported } = useMyWhatsAppSends();
  return (
    <WhatsAppSendsContext.Provider value={{ items, refresh, supported }}>
      {contextHolder}
      {children}
    </WhatsAppSendsContext.Provider>
  );
};

/** What the bell reads: the user's own sends (pending ones are shown with «≈ когда»). */
export function useWhatsAppSends(): WhatsAppSendsContextValue {
  return useContext(WhatsAppSendsContext);
}
