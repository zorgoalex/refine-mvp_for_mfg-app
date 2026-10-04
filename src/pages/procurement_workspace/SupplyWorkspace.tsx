import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { supplierRequestsApi } from '../../api/supplierRequestsApi';
import type { ProcurementWorklistResponse } from '../../api/types/procurementWorkspaceApi.types';
import { Segmented } from '../../ui/Segmented';
import { ReceiptSection } from './ReceiptSection';
import { SupplierRequestsSection } from './SupplierRequestsSection';
import { WorklistSection, type WorklistSectionProps } from './WorklistSection';

export type SupplySection = 'worklist' | 'receipt' | 'requests';

export interface SupplyWorkspaceProps extends WorklistSectionProps {}

function resolveSection(value: string | null, requestsAvailable: boolean): SupplySection {
  if (value === 'receipt') return 'receipt';
  if (value === 'requests' && requestsAvailable) return 'requests';
  return 'worklist';
}

/**
 * «Экран снабжения»: переключатель «Рабочий список» / «Приход 1С» / «Заявки поставщикам»,
 * раздел — в адресе страницы (`section=`), остальные параметры (фильтры рабочего списка,
 * `receipt=`) не трогаются. `WorklistSection` не меняется — только выбор, какую секцию
 * показать; «Заявки поставщикам» видны только при `capabilities.supplierRequests` (флаг
 * поднимается из `WorklistSection`, которая уже опрашивает рабочий список).
 */
export function SupplyWorkspace({ active, onUrgentCount }: SupplyWorkspaceProps) {
  const [searchParams, setSearchParams] = useSearchParams();
  const [capabilities, setCapabilities] = useState<ProcurementWorklistResponse['capabilities'] | null>(null);
  // Прямой вход не в «Рабочий список» (например, section=receipt): capabilities рабочего списка ещё нет —
  // доступность раздела узнаём лёгким запросом списка черновиков (503 при выключенном флаге; CR5-1).
  const [probedRequests, setProbedRequests] = useState<boolean | null>(null);
  const rawSection = searchParams.get('section');
  useEffect(() => {
    if (!active || capabilities !== null || probedRequests !== null || rawSection === null) return undefined;
    let alive = true;
    supplierRequestsApi.list({ status: 'draft' })
      .then(() => { if (alive) setProbedRequests(true); })
      .catch(() => { if (alive) setProbedRequests(false); });
    return () => { alive = false; };
  }, [active, capabilities, probedRequests, rawSection]);
  const requestsAvailable = capabilities !== null ? capabilities.supplierRequests === true : probedRequests === true;
  const section = resolveSection(searchParams.get('section'), requestsAvailable);

  const changeSection = (next: SupplySection) => setSearchParams((current) => {
    const params = new URLSearchParams(current);
    if (next === 'worklist') params.delete('section'); else params.set('section', next);
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
          ...(requestsAvailable ? [{ value: 'requests', label: 'Заявки поставщикам' }] : []),
        ]}
      />
      </div>
      {section === 'worklist' && <WorklistSection active={active} onUrgentCount={onUrgentCount} onCapabilities={setCapabilities} />}
      {section === 'receipt' && <ReceiptSection active={active} />}
      {section === 'requests' && <SupplierRequestsSection active={active} />}
    </div>
  );
}
