import React, { createContext, useContext, useLayoutEffect, useMemo } from 'react';
import { isModernUiVariant, setDocumentUiVariant, type UiVariant } from './uiVariant';

interface UiVariantContextValue {
  variant: UiVariant;
  isEvolution: boolean;
  isModern: boolean;
}

const UiVariantContext = createContext<UiVariantContextValue | null>(null);

export const UiVariantProvider: React.FC<
  React.PropsWithChildren<{ initialVariant: UiVariant }>
> = ({ initialVariant, children }) => {
  useLayoutEffect(() => {
    setDocumentUiVariant(initialVariant);
  }, [initialVariant]);

  const value = useMemo<UiVariantContextValue>(
    () => ({
      variant: initialVariant,
      isEvolution: initialVariant === 'evolution',
      isModern: isModernUiVariant(initialVariant),
    }),
    [initialVariant],
  );

  return (
    <UiVariantContext.Provider value={value}>
      <div className="ui-variant-root" data-ui-variant={initialVariant}>
        {children}
      </div>
    </UiVariantContext.Provider>
  );
};

export function useUiVariant(): UiVariantContextValue {
  const value = useContext(UiVariantContext);
  if (!value) throw new Error('useUiVariant must be used inside UiVariantProvider');
  return value;
}
