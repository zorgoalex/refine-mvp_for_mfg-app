import { IResourceComponentsProps } from '@refinedev/core';
import { LocalizedList } from '../../components/LocalizedList';
import { MillingExtraResourcesEditor } from '../milling_types/MillingExtraResourcesEditor';

export const MillingExtraResourcesList: React.FC<IResourceComponentsProps> = () => (
  <LocalizedList title="Доп. ресурсы фрезеровок">
    <MillingExtraResourcesEditor />
  </LocalizedList>
);
