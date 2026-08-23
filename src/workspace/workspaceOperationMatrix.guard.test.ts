import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PAGE_OWNED_WORKSPACE_OPERATION_IDS } from './workspaceOperationPins';

interface MatrixRow {
  operationId: string;
  surface: string;
  endpoints: string[];
  backendCommandOwner: string;
  permissionScopeVersionContract: string;
  persistedIdempotencyContract: string;
  auditHistoryContract: string;
  notificationOutboxContract: string;
  boundaries: string[];
  abortRetryPolicy: string;
  reconciliation: string;
  authTransition: string;
  detachmentDecision: string;
}

interface OperationMatrix {
  schemaVersion: number;
  policy: {
    genericDetachmentAllowed: boolean;
    allowlistedDetachedOperations: string[];
    workspaceOperationRegistryImplemented: boolean;
  };
  rows: MatrixRow[];
}

const readSource = (relativePath: string): string =>
  readFileSync(resolve(__dirname, relativePath), 'utf8');

function readMatrix(): OperationMatrix {
  const relativePath = 'spec_erp/reviews/order-operation-owner-matrix.json';
  const candidates = [
    resolve(__dirname, 'fixtures/order-operation-owner-matrix.json'),
    resolve(process.cwd(), '..', relativePath),
    resolve(process.cwd(), '..', '..', relativePath),
  ];
  const path = candidates.find(existsSync);
  if (!path) throw new Error(`Missing ${relativePath}`);
  return JSON.parse(readFileSync(path, 'utf8')) as OperationMatrix;
}

describe('order operation owner matrix', () => {
  it('has one complete page-owned row for every closed catalog id', () => {
    const matrix = readMatrix();
    const requiredFields: Array<keyof MatrixRow> = [
      'operationId',
      'surface',
      'endpoints',
      'backendCommandOwner',
      'permissionScopeVersionContract',
      'persistedIdempotencyContract',
      'auditHistoryContract',
      'notificationOutboxContract',
      'boundaries',
      'abortRetryPolicy',
      'reconciliation',
      'authTransition',
      'detachmentDecision',
    ];

    expect(matrix.schemaVersion).toBe(2);
    expect(matrix.rows.map((row) => row.operationId).sort()).toEqual(
      [...PAGE_OWNED_WORKSPACE_OPERATION_IDS].sort(),
    );
    matrix.rows.forEach((row) => {
      requiredFields.forEach((field) => expect(row[field]).toBeTruthy());
      expect(row.endpoints.length).toBeGreaterThan(0);
      expect(row.boundaries).toContain('not-started');
      expect(row.boundaries).toContain('terminal');
      expect(row.detachmentDecision).toBe('page-owned-pin');
    });
  });

  it('forbids a generic detached registry until an executable row passes every gate', () => {
    const matrix = readMatrix();
    expect(matrix.policy).toMatchObject({
      genericDetachmentAllowed: false,
      allowlistedDetachedOperations: [],
      workspaceOperationRegistryImplemented: false,
    });
    expect(existsSync(resolve(__dirname, 'workspaceOperationRegistry.ts'))).toBe(false);
  });

  it('wires every page-owned operation id to an exact async owner', () => {
    const sources = [
      '../hooks/useProductionStatusEvent.ts',
      '../pages/orders/show.tsx',
      '../pages/orders/components/OrderForm.tsx',
      '../pages/orders/components/AddToCutModal.tsx',
      '../pages/orders/components/OrderDetailTransferModal.tsx',
      '../pages/orders/components/sections/OrderTelegramScreenshots.tsx',
      '../pages/orders/components/tabs/OrderHdfTab.tsx',
      '../pages/orders/deadlines/OrderDeadlinePanel.tsx',
      '../pages/bazis-cut/AddToBazisCutModal.tsx',
      '../pages/orders/components/groups/GroupLinksEditor.tsx',
      '../pages/orders/components/import/ExcelImportModal.tsx',
      '../pages/orders/components/import/PdfImportModal.tsx',
      '../pages/orders/components/import/VlmImportModal.tsx',
      '../pages/orders/components/labels/OrderLabelDataEditor.tsx',
      '../pages/orders/components/labels/OrderLabelGenerateAction.tsx',
    ].map(readSource).join('\n');

    PAGE_OWNED_WORKSPACE_OPERATION_IDS.forEach((operationId) => {
      expect(sources, `missing page owner for ${operationId}`).toContain(`'${operationId}'`);
    });
  });

  it('quarantines high-risk multi-step owners across auth namespace changes', () => {
    const runnerOwnedSources = [
      '../hooks/useProductionStatusEvent.ts',
      '../pages/bazis-cut/AddToBazisCutModal.tsx',
      '../pages/calendar/components/CalendarBoard.tsx',
      '../pages/orders/components/OrderDetailTransferModal.tsx',
      '../pages/orders/components/OrderForm.tsx',
      '../pages/orders/components/OrderHeaderContextMenu.tsx',
      '../pages/orders/components/sections/OrderBasicInfo.tsx',
      '../pages/orders/components/tabs/OrderHdfTab.tsx',
    ];

    runnerOwnedSources.forEach((path) => {
      const source = readSource(path);
      expect(source, `${path} must use auth-quarantined operation runner`).toContain(
        'runPageOwnedWorkspaceOperation',
      );
    });

    const saveSource = readSource('../hooks/useOrderSave.ts');
    expect(saveSource).toContain('assertSaveOwnerCurrent();');
    expect(saveSource).toContain('getWorkspaceStateNamespace() !== saveOwnerNamespace');

    const exportSource = readSource('../hooks/useOrderExport.ts');
    expect(exportSource).toContain('owner?.assertOwnerCurrent();');
  });
});
