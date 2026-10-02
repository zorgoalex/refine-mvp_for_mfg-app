import React, { useEffect, useRef, useState } from 'react';
import { Typography } from 'antd';
import type { WhatsAppGroupDto } from '../../../api/types/whatsappApi.types';
import { maskGroupId } from './broadcasts/broadcastModel';
import { trackMounted } from './WhatsAppGroupSelect';
import { loadWhatsAppGroups } from './whatsappGroupsCache';
import { findGroupById, groupDisplayName } from './whatsappGroupsView';

const { Text } = Typography;

/**
 * Read-only group name for a stored chat id: «Название · 1203…@g.us». Without the
 * list (WhatsApp offline, no rights, group left) only the masked id is shown.
 */
export const WhatsAppGroupLabel: React.FC<{ id: string | null }> = ({ id }) => {
  const [groups, setGroups] = useState<WhatsAppGroupDto[] | null>(null);
  const mounted = useRef(false);
  useEffect(() => trackMounted(mounted), []);
  useEffect(() => {
    if (!id) return;
    loadWhatsAppGroups().then(
      (next) => { if (mounted.current) setGroups(next); },
      () => undefined,
    );
  }, [id]);

  const group = groups ? findGroupById(groups, id) : undefined;
  if (!group) return <>{maskGroupId(id)}</>;
  return (
    <span title={id ?? undefined}>
      {groupDisplayName(group)} <Text type="secondary">· {maskGroupId(id)}</Text>
    </span>
  );
};
