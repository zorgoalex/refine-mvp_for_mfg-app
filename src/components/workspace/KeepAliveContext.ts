import { createContext, useContext } from 'react';

export const KeepAliveContext = createContext<{ isActive: boolean }>({ isActive: true });
export const useKeepAlive = () => useContext(KeepAliveContext);
