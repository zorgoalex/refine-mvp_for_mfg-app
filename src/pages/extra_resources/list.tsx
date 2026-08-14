import { IResourceComponentsProps } from '@refinedev/core';
import { LocalizedList } from '../../components/LocalizedList';
import { ExtraResourcesDictionary } from './ExtraResourcesDictionary';

export const ExtraResourcesList: React.FC<IResourceComponentsProps> = () => (
  <LocalizedList title="Доп. ресурсы">
    <ExtraResourcesDictionary />
  </LocalizedList>
);
