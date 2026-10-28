import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Descriptions, Space, Typography } from 'antd';
import { UploadOutlined } from '@ant-design/icons';
import { Link } from 'react-router-dom';
import { bazisApi } from '../../api/bazisApi';
import type { BazisProjectListItem } from '../../api/types/bazisApi.types';
import { featureFlags } from '../../config/featureFlags';
import { can } from '../../utils/permissions';
import { useBazisCardsCapability } from '../../hooks/useBazisCardsCapability';
import { ImportWizardModal } from '../bazis/ImportWizardModal';

const { Text } = Typography;

/**
 * «XML Базиса» of a Bazis project card: the XML projects attached to it (links to the XML viewer) and an import of a
 * new XML into this card (`POST /bazis/cards/imports` with the card). Shown with bazis.view; the import with
 * bazis.manage (the backend also checks the right and the scope of the card).
 */
export const CardXmlBlock: React.FC<{ dowelingOrderId: number }> = ({ dowelingOrderId }) => {
  const [projects, setProjects] = useState<BazisProjectListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const cardsSupported = useBazisCardsCapability();
  // The block and its wizard stay mounted whatever the capability says: a running import keeps its file, route and key
  // (R4 #1); the capability hides only the start of a new import.
  const visible = featureFlags.useBackendBazis && can('bazis.view');
  // Only the answer of the latest request is shown: a list asked before the capability turned out «no» (R5 #2).
  const requestSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++requestSeq.current;
    // An older backend ignores the card filter (it would list every XML project): no list then.
    if (!visible || !cardsSupported) {
      setProjects([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const listed = await bazisApi.listCardProjects(dowelingOrderId);
      // Only the XML projects of this card, whatever a backend sent back.
      if (seq === requestSeq.current) setProjects(listed.filter((project) => project.card?.dowelingOrderId === dowelingOrderId));
    } catch (loadError) {
      if (seq === requestSeq.current) setError(loadError instanceof Error ? loadError.message : 'Не удалось загрузить XML Базиса');
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [cardsSupported, dowelingOrderId, visible]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!visible) return null;

  return (
    <>
      <Descriptions
        title={(
          <Space>
            <span>XML Базиса</span>
            {can('bazis.manage') && cardsSupported ? (
              <Button size="small" icon={<UploadOutlined />} onClick={() => setImportOpen(true)}>
                Загрузить XML
              </Button>
            ) : null}
          </Space>
        )}
        column={1}
        size="small"
        bordered
        style={{ marginTop: 16 }}
      >
        {!cardsSupported ? (
          <Descriptions.Item label="XML"><Text type="secondary">Недоступно: обновите страницу</Text></Descriptions.Item>
        ) : loading ? (
          <Descriptions.Item label="XML">Загрузка…</Descriptions.Item>
        ) : error ? (
          <Descriptions.Item label="XML"><Text type="danger">{error}</Text></Descriptions.Item>
        ) : projects.length === 0 ? (
          <Descriptions.Item label="XML"><Text type="secondary">Не прикреплён</Text></Descriptions.Item>
        ) : (
          projects.map((project) => (
            <Descriptions.Item key={project.bazisProjectId} label={project.bazisOrderNo?.trim() || 'XML'}>
              <Link to={`/bazis/projects/${project.bazisProjectId}`}>{project.name}</Link>
              <Text type="secondary"> · ревизий: {project.revisionsCount}</Text>
            </Descriptions.Item>
          ))
        )}
      </Descriptions>
      <ImportWizardModal
        open={importOpen}
        dowelingOrderId={dowelingOrderId}
        onClose={() => setImportOpen(false)}
        onImported={() => {
          void load();
        }}
        onOpenTree={() => {
          setImportOpen(false);
          void load();
        }}
      />
    </>
  );
};
