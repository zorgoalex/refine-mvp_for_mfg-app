import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { InboxOutlined, LinkOutlined, LoadingOutlined, CheckCircleOutlined, MinusOutlined } from '@ant-design/icons';
import { useLocation, useNavigate } from 'react-router-dom';
import { useSelect } from '@refinedev/antd';
import { Alert, Button, Descriptions, Input, Modal, Radio, Select, Space, Spin, Steps, Tree, Typography, Upload, message } from 'antd';
import { ApiError } from '../../api/apiError';
import { bazisApi } from '../../api/bazisApi';
import { projectsApi, type ProjectDto } from '../../api/projectsApi';
import type { BazisImportResponse, BazisProjectCard, BazisProjectListItem, MaterialMapping } from '../../api/types/bazisApi.types';
import { DraggableModalWrapper } from '../../components/DraggableModalWrapper';
import { MinimizedModalChip } from '../../components/MinimizedModalChip';
import { useKeepAlive } from '../../components/workspace/KeepAliveContext';
import { createBackendSelectProps, useOrderFormData } from '../../hooks/useOrderFormData';
import { MaterialMappingStep, materialMappingKey, type MaterialMappingValue, type UnmappedMaterialRow } from './MaterialMappingStep';
import { parseXmlPreview, XmlPreviewError, type XmlPreviewNode, type XmlPreviewResult } from './parseXmlPreview';

const { Dragger } = Upload;

function collectPreviewExpandKeys(nodes: XmlPreviewNode[], maxDepth: number, depth = 1): number[] {
  if (depth > maxDepth) return [];
  return nodes.flatMap((node) =>
    node.children && node.children.length > 0
      ? [node.key, ...collectPreviewExpandKeys(node.children, maxDepth, depth + 1)]
      : []);
}

function createWizardUuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

const SUMMARY_LABELS_RU: Record<string, string> = {
  totalNodes: 'Всего узлов',
  panels: 'Панели',
  hardware: 'Фурнитура',
  assemblies: 'Сборки',
  blocks: 'Блоки',
  uniqueMaterials: 'Уникальных материалов',
};
const { Text } = Typography;

interface ImportWizardModalProps {
  open: boolean;
  onClose: () => void;
  onImported: () => void;
  onOpenTree: (revisionId: number, label: string, projectId: number | null) => void;
  onCreateOrder: (revisionId: number, label: string, projectId: number | null) => void;
}

type BindingMode = 'bazis' | 'erp' | 'new';

interface SummaryState {
  bazisProjectId: number;
  bazisProjectName: string;
  projectId: number;
  revisionId: number;
  revisionNo: number;
  summary: Record<string, number>;
  warnings: string[];
  duplicateMessage?: string;
}

type StepKey = 'file' | 'binding' | 'import' | 'materials' | 'summary';

export const ImportWizardModal: React.FC<ImportWizardModalProps> = ({
  open,
  onClose,
  onImported,
  onOpenTree,
  onCreateOrder,
}) => {
  const [currentStep, setCurrentStep] = useState<StepKey>('file');
  const [minimized, setMinimized] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const { isActive: isTabActive } = useKeepAlive();
  const [xmlFile, setXmlFile] = useState<File | null>(null);
  const [bindingMode, setBindingMode] = useState<BindingMode>('bazis');
  const [bazisProjects, setBazisProjects] = useState<BazisProjectListItem[]>([]);
  const [bazisProjectsLoading, setBazisProjectsLoading] = useState(false);
  const [erpProjects, setErpProjects] = useState<ProjectDto[]>([]);
  const [erpProjectsLoading, setErpProjectsLoading] = useState(false);
  const [selectedBazisProjectId, setSelectedBazisProjectId] = useState<number | undefined>(undefined);
  const [selectedProjectId, setSelectedProjectId] = useState<number | undefined>(undefined);
  const [preview, setPreview] = useState<XmlPreviewResult | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [newProjectName, setNewProjectName] = useState('');
  const [newProjectClientId, setNewProjectClientId] = useState<number | undefined>(undefined);
  const [createProjectKey, setCreateProjectKey] = useState<string>(createWizardUuid);
  const [importLoading, setImportLoading] = useState(false);
  // Гейт повторного запуска импорта БЕЗ участия в deps: importLoading в deps
  // самого эффекта отменял (cancelled=true) собственный запрос сразу после
  // setImportLoading(true) → ответ выбрасывался, спиннер зависал навсегда.
  const importLoadingRef = useRef(false);
  const [importErrorText, setImportErrorText] = useState<string | null>(null);
  const [summary, setSummary] = useState<SummaryState | null>(null);
  const [unmappedMaterials, setUnmappedMaterials] = useState<UnmappedMaterialRow[]>([]);
  const [mappingValues, setMappingValues] = useState<Record<string, MaterialMappingValue>>({});
  const [mappingLoading, setMappingLoading] = useState(false);

  const orderFormData = useOrderFormData();
  const useBackendReferences = orderFormData.enabled;
  const { selectProps: legacyClientSelectProps } = useSelect({
    resource: 'clients',
    optionLabel: 'client_name',
    optionValue: 'client_id',
    filters: [{ field: 'is_active', operator: 'eq', value: true }],
    queryOptions: { enabled: open && !useBackendReferences && bindingMode === 'new' },
  });
  const resolvedClientProps = useBackendReferences
    ? createBackendSelectProps(orderFormData.references.clients, orderFormData.isLoading)
    : legacyClientSelectProps;

  const steps = useMemo(() => {
    const items: Array<{ key: StepKey; title: string; icon: React.ReactNode }> = [
      { key: 'file', title: 'Файл', icon: <InboxOutlined /> },
      { key: 'binding', title: 'Привязка', icon: <LinkOutlined /> },
      { key: 'import', title: 'Импорт', icon: <LoadingOutlined /> },
    ];

    if (unmappedMaterials.length > 0) {
      items.push({ key: 'materials', title: 'Материалы', icon: <LinkOutlined /> });
    }

    items.push({ key: 'summary', title: 'Готово', icon: <CheckCircleOutlined /> });
    return items;
  }, [unmappedMaterials.length]);

  const currentStepIndex = steps.findIndex((step) => step.key === currentStep);

  useEffect(() => {
    if (!isTabActive && open && !minimized) {
      setMinimized(true);
    }
  }, [isTabActive, minimized, open]);

  const resetState = useCallback(() => {
    setMinimized(false);
    setCurrentStep('file');
    setXmlFile(null);
    setBindingMode('bazis');
    setSelectedBazisProjectId(undefined);
    setSelectedProjectId(undefined);
    setPreview(null);
    setPreviewError(null);
    setNewProjectName('');
    setNewProjectClientId(undefined);
    setCreateProjectKey(createWizardUuid());
    importLoadingRef.current = false;
    setImportLoading(false);
    setImportErrorText(null);
    setSummary(null);
    setUnmappedMaterials([]);
    setMappingValues({});
    setMappingLoading(false);
  }, []);

  useEffect(() => {
    if (!open) {
      resetState();
      return;
    }

    let cancelled = false;

    const loadBindings = async () => {
      setBazisProjectsLoading(true);
      setErpProjectsLoading(true);
      try {
        const [bazisResponse, erpResponse] = await Promise.all([
          bazisApi.listProjects(),
          projectsApi.list(),
        ]);

        if (!cancelled) {
          setBazisProjects(bazisResponse);
          setErpProjects(erpResponse);
        }
      } catch (error) {
        if (!cancelled) {
          message.error(error instanceof Error ? error.message : 'Не удалось загрузить проекты');
        }
      } finally {
        if (!cancelled) {
          setBazisProjectsLoading(false);
          setErpProjectsLoading(false);
        }
      }
    };

    void loadBindings();

    return () => {
      cancelled = true;
    };
  }, [open, resetState]);

  // onImported приходит инлайн-лямбдой от родителя (новая ссылка на каждый рендер) —
  // через ref, чтобы не входить в deps импорт-эффекта и не отменять запрос re-run'ом.
  const onImportedRef = useRef(onImported);
  onImportedRef.current = onImported;

  useEffect(() => {
    if (!open || currentStep !== 'import' || importLoadingRef.current || summary != null || xmlFile == null) {
      return;
    }

    if (bindingMode === 'bazis' && selectedBazisProjectId == null) {
      return;
    }

    if (bindingMode === 'erp' && selectedProjectId == null) {
      return;
    }

    if (bindingMode === 'new' && (newProjectClientId == null || !newProjectName.trim())) {
      return;
    }

    let cancelled = false;

    const runImport = async () => {
      importLoadingRef.current = true;
      setImportLoading(true);
      setImportErrorText(null);

      try {
        let targetProjectId = selectedProjectId;
        if (bindingMode === 'new') {
          // idempotencyKey фиксируется на open: ретрай после падения импорта
          // не создаст второй проект
          const created = await projectsApi.create({
            clientId: newProjectClientId as number,
            name: newProjectName.trim(),
            idempotencyKey: createProjectKey,
          });
          if (cancelled) {
            return;
          }
          targetProjectId = created.projectId;
        }

        const response = await bazisApi.import(
          xmlFile,
          bindingMode === 'bazis'
            ? { bazisProjectId: selectedBazisProjectId }
            : { projectId: targetProjectId },
        );
        if (cancelled) {
          return;
        }

        applyImportResponse(response);
        onImportedRef.current();
      } catch (error) {
        if (cancelled) {
          return;
        }

        if (error instanceof ApiError && error.code === 'BAZIS_REVISION_DUPLICATE' && selectedBazisProjectId != null) {
          try {
            const projectCard = await bazisApi.getProject(selectedBazisProjectId);
            const duplicateSummary = buildDuplicateSummary(projectCard, error);
            if (duplicateSummary) {
              setSummary(duplicateSummary);
              setUnmappedMaterials([]);
              setCurrentStep('summary');
              return;
            }
          } catch (cardError) {
            setImportErrorText(cardError instanceof Error ? cardError.message : error.message);
            return;
          }
        }

        setImportErrorText(formatImportError(error));
      } finally {
        importLoadingRef.current = false;
        setImportLoading(false);
      }
    };

    void runImport();

    return () => {
      cancelled = true;
    };
    // importLoading/onImported сознательно НЕ в deps: собственный setState не должен
    // перезапускать эффект и отменять in-flight импорт (deadlock вечного спиннера).
  }, [
    bindingMode,
    createProjectKey,
    currentStep,
    newProjectClientId,
    newProjectName,
    open,
    selectedBazisProjectId,
    selectedProjectId,
    summary,
    xmlFile,
  ]);

  useEffect(() => {
    if (currentStep !== 'materials' || unmappedMaterials.length === 0) {
      return;
    }

    let cancelled = false;

    const loadExistingMappings = async () => {
      try {
        const response = await bazisApi.listMaterialMappings(unmappedMaterials.map((item) => item.name));
        if (cancelled) {
          return;
        }

        setMappingValues((prev) => ({
          ...buildMappingValueState(response),
          ...prev,
        }));
      } catch {
        // Non-blocking.
      }
    };

    void loadExistingMappings();

    return () => {
      cancelled = true;
    };
  }, [currentStep, unmappedMaterials]);

  const applyImportResponse = (response: BazisImportResponse) => {
    setSummary({
      bazisProjectId: response.bazisProject.bazisProjectId,
      bazisProjectName: response.bazisProject.name,
      projectId: response.bazisProject.projectId,
      revisionId: response.revision.bazisRevisionId,
      revisionNo: response.revision.revisionNo,
      summary: response.revision.summary,
      warnings: response.warnings,
    });
    setUnmappedMaterials(response.unmappedMaterials);
    setCurrentStep(response.unmappedMaterials.length > 0 ? 'materials' : 'summary');
  };

  const handleClose = () => {
    resetState();
    onClose();
  };

  // Клик по маске / Esc НЕ должны терять работу визарда — сворачиваем.
  // Полное закрытие — только крестик и кнопка «Отмена».
  const handleCancelEvent = (event: React.MouseEvent | React.KeyboardEvent) => {
    const target = event.target as HTMLElement | null;
    if (target?.closest?.('.ant-modal-close')) {
      handleClose();
      return;
    }
    setMinimized(true);
  };

  const handleNext = async () => {
    if (currentStep === 'file') {
      if (!xmlFile) {
        message.warning('Выберите XML-файл');
        return;
      }
      setCurrentStep('binding');
      return;
    }

    if (currentStep === 'binding') {
      if (bindingMode === 'bazis' && selectedBazisProjectId == null) {
        message.warning('Выберите Базис-проект');
        return;
      }
      if (bindingMode === 'erp' && selectedProjectId == null) {
        message.warning('Выберите ERP-проект');
        return;
      }
      if (bindingMode === 'new') {
        if (newProjectClientId == null) {
          message.warning('Выберите клиента нового проекта');
          return;
        }
        if (!newProjectName.trim()) {
          message.warning('Укажите название проекта');
          return;
        }
      }
      setCurrentStep('import');
      return;
    }

    if (currentStep === 'materials') {
      if (unmappedMaterials.some((item) => mappingValues[materialMappingKey(item)] == null || mappingValues[materialMappingKey(item)].targetKind == null)) {
        message.warning('Для каждого материала выберите соответствие или "Пропустить"');
        return;
      }

      setMappingLoading(true);
      try {
        await bazisApi.upsertMaterialMappings(
          unmappedMaterials.map((item) => {
            const mapping = mappingValues[materialMappingKey(item)];
            const sourceKind = normalizeSourceKind(item.kindGuess);
            if (mapping == null || sourceKind == null) {
              throw new Error(`Некорректное сопоставление для ${item.name}`);
            }

            return {
              sourceKind,
              bazisName: item.name,
              targetKind: mapping.targetKind ?? 'ignore',
              sheetMaterialTypeId: mapping.targetKind === 'sheet' ? mapping.targetId : null,
              filmId: mapping.targetKind === 'film' ? mapping.targetId : null,
              edgeTypeId: mapping.targetKind === 'edge' ? mapping.targetId : null,
            };
          }),
        );
        setCurrentStep('summary');
      } catch (error) {
        message.error(error instanceof Error ? error.message : 'Не удалось сохранить сопоставления');
      } finally {
        setMappingLoading(false);
      }
    }
  };

  const handleBack = () => {
    if (currentStep === 'binding') {
      setCurrentStep('file');
      return;
    }

    if (currentStep === 'import') {
      setImportErrorText(null);
      setSummary(null);
      setCurrentStep('binding');
      return;
    }

    if (currentStep === 'materials') {
      // Возврат к привязке = новая попытка импорта: импорт-эффект гейтится
      // summary != null, без сброса шаг import застревает на прошлом состоянии
      // (Critic R2 finding 2).
      setSummary(null);
      setUnmappedMaterials([]);
      setMappingValues({});
      setImportErrorText(null);
      setCurrentStep('binding');
      return;
    }

    if (currentStep === 'summary') {
      setCurrentStep(unmappedMaterials.length > 0 ? 'materials' : 'binding');
    }
  };

  const footer = currentStep === 'summary'
    ? null
    : (
      <Space>
        <Button onClick={handleClose}>Отмена</Button>
        <Button onClick={handleBack} disabled={currentStep === 'file' || importLoading || mappingLoading}>
          Назад
        </Button>
        <Button
          type="primary"
          onClick={() => void handleNext()}
          loading={importLoading || mappingLoading}
          disabled={currentStep === 'import'}
        >
          Далее
        </Button>
      </Space>
    );

  return (
    <>
      <Modal
      open={open && !minimized}
      onCancel={handleCancelEvent}
      footer={footer}
      destroyOnClose
      width={920}
      title={(
        <Space size={8}>
          <span>Импорт Bazis XML</span>
          <Button
            type="text"
            size="small"
            icon={<MinusOutlined />}
            title="Свернуть"
            onClick={() => setMinimized(true)}
          />
        </Space>
      )}
      modalRender={(modal) => <DraggableModalWrapper open={open && !minimized}>{modal}</DraggableModalWrapper>}
    >
      <Space direction="vertical" size="large" style={{ width: '100%' }}>
        <Steps current={currentStepIndex} items={steps} />

        {currentStep === 'file' ? (
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <Dragger
              accept=".xml"
              multiple={false}
              showUploadList={false}
              beforeUpload={(file) => {
                // antd 5.0.5: при `beforeUpload → false` onChange получает КЛОН File
                // без originFileObj — файл забираем прямо здесь (паттерн OcrTemplateEditor)
                setXmlFile(file);
                setPreview(null);
                setPreviewError(null);
                void file.text().then(
                  (text) => {
                    try {
                      setPreview(parseXmlPreview(text));
                    } catch (error) {
                      setPreviewError(error instanceof XmlPreviewError ? error.message : 'Не удалось построить предпросмотр');
                    }
                  },
                  () => setPreviewError('Не удалось прочитать файл'),
                );
                return false;
              }}
            >
              <p className="ant-upload-drag-icon">
                <InboxOutlined />
              </p>
              <p className="ant-upload-text">Перетащите XML сюда или нажмите для выбора файла</p>
            </Dragger>
            {xmlFile ? <Alert type="success" showIcon message={`Файл выбран: ${xmlFile.name}`} /> : null}
            {previewError ? <Alert type="warning" showIcon message={previewError} /> : null}
            {preview ? (
              <Space direction="vertical" size={4} style={{ width: '100%' }}>
                <Text strong>
                  Состав проекта{preview.productName ? ` «${preview.productName}»` : ''} · узлов: {preview.totalNodes}
                </Text>
                <Tree<XmlPreviewNode>
                  treeData={preview.tree}
                  defaultExpandedKeys={collectPreviewExpandKeys(preview.tree, 2)}
                  selectable={false}
                  height={360}
                  virtual
                  blockNode
                />
              </Space>
            ) : null}
          </Space>
        ) : null}

        {currentStep === 'binding' ? (
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <Radio.Group
              value={bindingMode}
              onChange={(event) => {
                const mode = event.target.value as BindingMode;
                setBindingMode(mode);
                if (mode === 'new' && !newProjectName && preview?.productName) {
                  setNewProjectName(preview.productName);
                }
              }}
            >
              <Space direction="vertical">
                <Radio value="bazis">Существующий Базис-проект</Radio>
                <Radio value="erp">Существующий ERP-проект</Radio>
                <Radio value="new">Новый проект</Radio>
              </Space>
            </Radio.Group>

            {bindingMode === 'bazis' ? (
              <Select
                showSearch
                allowClear
                optionFilterProp="label"
                loading={bazisProjectsLoading}
                placeholder="Выберите Базис-проект"
                value={selectedBazisProjectId}
                onChange={(value) => setSelectedBazisProjectId(value)}
                options={bazisProjects.map((item) => ({
                  value: item.bazisProjectId,
                  label: `${item.name} · ERP #${item.projectId}`,
                }))}
              />
            ) : null}

            {bindingMode === 'erp' ? (
              <Select
                showSearch
                allowClear
                optionFilterProp="label"
                loading={erpProjectsLoading}
                placeholder="Выберите ERP-проект"
                value={selectedProjectId}
                onChange={(value) => setSelectedProjectId(value)}
                options={erpProjects.map((item) => ({
                  value: item.projectId,
                  label: `${item.code} · ${item.name}`,
                }))}
              />
            ) : null}

            {bindingMode === 'new' ? (
              <Space direction="vertical" size="middle" style={{ width: '100%' }}>
                <Select
                  {...resolvedClientProps}
                  showSearch
                  allowClear
                  optionFilterProp="label"
                  placeholder="Клиент нового проекта"
                  value={newProjectClientId}
                  onChange={(value) => setNewProjectClientId(value as number | undefined)}
                  style={{ width: '100%' }}
                />
                <Input
                  placeholder="Название проекта"
                  value={newProjectName}
                  onChange={(event) => setNewProjectName(event.target.value)}
                  maxLength={300}
                />
              </Space>
            ) : null}
          </Space>
        ) : null}

        {currentStep === 'import' ? (
          importErrorText ? (
            <Alert type="warning" showIcon message={importErrorText} />
          ) : (
            <Space direction="vertical" size="middle" style={{ width: '100%', alignItems: 'center' }}>
              <Spin size="large" />
              <Text>Импортирую XML и создаю ревизию…</Text>
            </Space>
          )
        ) : null}

        {currentStep === 'materials' ? (
          <MaterialMappingStep
            items={unmappedMaterials}
            values={mappingValues}
            onChange={(mappingKey, nextValue) => {
              setMappingValues((prev) => ({ ...prev, [mappingKey]: nextValue }));
            }}
          />
        ) : null}

        {currentStep === 'summary' && summary ? (
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            {summary.duplicateMessage ? (
              <Alert type="warning" showIcon message={summary.duplicateMessage} />
            ) : null}
            {summary.warnings.map((warning) => (
              <Alert key={warning} type="warning" showIcon message={warning} />
            ))}

            <Descriptions bordered size="small" column={1}>
              <Descriptions.Item label="Базис-проект">{summary.bazisProjectName}</Descriptions.Item>
              <Descriptions.Item label="ERP-проект">#{summary.projectId}</Descriptions.Item>
              <Descriptions.Item label="Ревизия">#{summary.revisionNo}</Descriptions.Item>
              {Object.entries(summary.summary).map(([key, value]) => (
                <Descriptions.Item key={key} label={SUMMARY_LABELS_RU[key] ?? key}>
                  {value}
                </Descriptions.Item>
              ))}
            </Descriptions>

            <Space wrap>
              <Button onClick={() => onOpenTree(summary.revisionId, buildRevisionLabel(summary), summary.projectId)}>
                Открыть дерево
              </Button>
              <Button type="primary" onClick={() => onCreateOrder(summary.revisionId, buildRevisionLabel(summary), summary.projectId)}>
                Создать заказ
              </Button>
              <Button onClick={handleClose}>Закрыть</Button>
            </Space>
          </Space>
        ) : null}
      </Space>
    </Modal>
      {open && minimized ? (
        <MinimizedModalChip
          title={`Импорт Bazis XML · ${steps[currentStepIndex]?.title ?? ''}`}
          slot={0}
          onRestore={() => {
            if (location.pathname !== '/bazis') {
              navigate('/bazis');
            }
            setMinimized(false);
          }}
          onClose={handleClose}
        />
      ) : null}
    </>
  );
};

function formatImportError(error: unknown): string {
  if (error instanceof ApiError) {
    return error.message;
  }

  return error instanceof Error ? error.message : 'Не удалось импортировать XML';
}

function buildDuplicateSummary(projectCard: BazisProjectCard, error: ApiError): SummaryState | null {
  const revisionNo = extractRevisionNo(error);
  const revision = revisionNo == null
    ? null
    : projectCard.revisions.find((item) => item.revisionNo === revisionNo) ?? null;

  if (!revision) {
    return null;
  }

  return {
    bazisProjectId: projectCard.bazisProjectId,
    bazisProjectName: projectCard.name,
    projectId: projectCard.projectId,
    revisionId: revision.bazisRevisionId,
    revisionNo: revision.revisionNo,
    summary: revision.summary,
    warnings: [],
    duplicateMessage: `Ревизия ${revision.revisionNo} уже есть`,
  };
}

function extractRevisionNo(error: ApiError): number | null {
  if (typeof error.details !== 'object' || error.details == null) {
    return null;
  }

  const value = (error.details as Record<string, unknown>).revisionNo;
  return typeof value === 'number' ? value : null;
}

function buildMappingValueState(items: MaterialMapping[]): Record<string, MaterialMappingValue> {
  return Object.fromEntries(items.map((item) => {
    const targetId = item.targetKind === 'sheet'
      ? item.sheetMaterialTypeId
      : item.targetKind === 'film'
        ? item.filmId
        : item.targetKind === 'edge'
          ? item.edgeTypeId
          : null;

    return [
      materialMappingKey({ name: item.bazisName, kindGuess: item.sourceKind }),
      {
        targetKind: item.targetKind === 'ignore' || item.targetKind === 'sheet' || item.targetKind === 'film' || item.targetKind === 'edge'
          ? item.targetKind
          : null,
        targetId: targetId ?? null,
      } satisfies MaterialMappingValue,
    ];
  }));
}

function normalizeSourceKind(value: string): 'sheet' | 'film' | 'edge' | null {
  if (value === 'sheet' || value === 'film' || value === 'edge') {
    return value;
  }

  return null;
}

function buildRevisionLabel(summary: SummaryState): string {
  return `${summary.bazisProjectName} · ревизия ${summary.revisionNo}`;
}
