import { useSearchParams } from 'react-router-dom';

import { Segmented } from '../../ui/Segmented';
import { ReceiptSection } from './ReceiptSection';
import { WorklistSection, type WorklistSectionProps } from './WorklistSection';

export type SupplySection = 'worklist' | 'receipt';

export interface SupplyWorkspaceProps extends WorklistSectionProps {}

function resolveSection(value: string | null): SupplySection {
  return value === 'receipt' ? 'receipt' : 'worklist';
}

/**
 * «Экран снабжения»: переключатель «Рабочий список» / «Приход 1С», раздел — в адресе
 * страницы (`section=`), остальные параметры (фильтры рабочего списка, `receipt=`) не
 * трогаются. `WorklistSection` не меняется — только выбор, какую секцию показать.
 */
export function SupplyWorkspace({ active, onUrgentCount }: SupplyWorkspaceProps) {
  const [searchParams, setSearchParams] = useSearchParams();
  const section = resolveSection(searchParams.get('section'));

  const changeSection = (next: SupplySection) => setSearchParams((current) => {
    const params = new URLSearchParams(current);
    if (next === 'receipt') params.set('section', 'receipt'); else params.delete('section');
    return params;
  }, { replace: true });

  return (
    // Как в мокапе: одна рамка — полоса разделов, затем раздел со своей полосой заголовка.
    <div className="rr-frame">
      <div className="rr-subnav">
      <Segmented
        aria-label="Раздел снабжения"
        value={section}
        onChange={(value) => changeSection(value as SupplySection)}
        options={[
          { value: 'worklist', label: 'Рабочий список' },
          { value: 'receipt', label: 'Приход 1С: подобрать заказы' },
        ]}
      />
      </div>
      {section === 'worklist'
        ? <WorklistSection active={active} onUrgentCount={onUrgentCount} />
        : <ReceiptSection active={active} />}
    </div>
  );
}
