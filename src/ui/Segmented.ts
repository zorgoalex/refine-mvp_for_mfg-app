import { Segmented as AntdSegmented, type SegmentedProps } from 'antd';
import type { ForwardRefExoticComponent, PropsWithoutRef, RefAttributes } from 'react';

// AntD 5.0.5's emitted Pick lists DOM keys absent from current React HTML props,
// making four nonexistent handlers required. Use its public props interface.
// This is the same runtime object: no wrapper, fake handlers or ref conversion.
export const Segmented = AntdSegmented as ForwardRefExoticComponent<
  PropsWithoutRef<SegmentedProps> & RefAttributes<HTMLDivElement>
>;
