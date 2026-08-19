import { useCallback, useEffect, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import { useInvalidate } from '@refinedev/core';
import { cncTelegramImportApi, createCncTelegramImportIdempotencyKey } from '../api/cncTelegramImportApi';
import type {
  CncTelegramImportCandidate,
  CncTelegramImportPrepareResponse,
  CncTelegramImportRequest,
  CncTelegramImportScan,
  CncTelegramImportScanRequest,
} from '../api/types/cncTelegramImportApi.types';

const ACTIVE_SCAN_STORAGE_KEY = 'cnc-telegram-import:active-scan';
const ACTIVE_REQUEST_STORAGE_KEY = 'cnc-telegram-import:active-request';
const POLL_INTERVAL_MS = 2500;

const activeScanStatuses = new Set(['pending', 'processing']);
const activeImportStatuses = new Set(['pending', 'processing']);

function readStoredId(key: string): string | null {
  try {
    const value = window.localStorage.getItem(key);
    return value?.trim() || null;
  } catch {
    return null;
  }
}

function writeStoredId(key: string, value: string | null): void {
  try {
    if (value) window.localStorage.setItem(key, value);
    else window.localStorage.removeItem(key);
  } catch {
    // Private browsing/storage policy must not break manual import.
  }
}

export function useCncTelegramImport(open: boolean) {
  const invalidate = useInvalidate();
  const [scan, setScan] = useState<CncTelegramImportScan | null>(null);
  const [candidates, setCandidates] = useState<CncTelegramImportCandidate[]>([]);
  const [importRequest, setImportRequest] = useState<CncTelegramImportRequest | null>(null);
  const [prepared, setPrepared] = useState<CncTelegramImportPrepareResponse | null>(null);
  const [loadingCandidates, setLoadingCandidates] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const scanPollRef = useRef<number | null>(null);
  const importPollRef = useRef<number | null>(null);

  const stopPoll = useCallback((ref: MutableRefObject<number | null>) => {
    if (ref.current !== null) window.clearInterval(ref.current);
    ref.current = null;
  }, []);

  const loadCandidates = useCallback(async (scanId: string) => {
    setLoadingCandidates(true);
    try {
      const all: CncTelegramImportCandidate[] = [];
      let page = 1;
      let totalPages = 1;
      do {
        const response = await cncTelegramImportApi.listCandidates(scanId, page, 100);
        all.push(...response.candidates);
        totalPages = response.pagination?.totalPages ?? 1;
        page += 1;
      } while (page <= totalPages && all.length < 500);
      setCandidates(all);
      setError(null);
    } catch (nextError) {
      setError(nextError);
    } finally {
      setLoadingCandidates(false);
    }
  }, []);

  const refreshScan = useCallback(async (scanId: string) => {
    const next = await cncTelegramImportApi.getScan(scanId);
    setScan(next);
    if (next.status === 'ready') {
      writeStoredId(ACTIVE_SCAN_STORAGE_KEY, null);
      await loadCandidates(next.scanId);
    } else if (next.status === 'failed' || next.status === 'expired') {
      writeStoredId(ACTIVE_SCAN_STORAGE_KEY, null);
    }
    return next;
  }, [loadCandidates]);

  const refreshImport = useCallback(async (importRequestId: string) => {
    const next = await cncTelegramImportApi.getRequest(importRequestId);
    setImportRequest(next);
    if (!activeImportStatuses.has(next.status)) {
      writeStoredId(ACTIVE_REQUEST_STORAGE_KEY, null);
      await Promise.all([
        invalidate({ resource: 'cut-jobs', invalidates: ['list'] }),
        invalidate({ resource: 'orders_view', invalidates: ['list'] }),
        invalidate({ resource: 'orders_status_board', invalidates: ['list'] }),
        invalidate({ resource: 'cnc-telegram', invalidates: ['list', 'detail'] }),
      ]);
    }
    return next;
  }, [invalidate]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const storedScanId = readStoredId(ACTIVE_SCAN_STORAGE_KEY);
    const storedRequestId = readStoredId(ACTIVE_REQUEST_STORAGE_KEY);
    if (storedScanId) {
      void refreshScan(storedScanId).catch((nextError) => {
        if (!cancelled) {
          writeStoredId(ACTIVE_SCAN_STORAGE_KEY, null);
          setError(nextError);
        }
      });
    }
    if (storedRequestId) {
      void refreshImport(storedRequestId).catch((nextError) => {
        if (!cancelled) {
          writeStoredId(ACTIVE_REQUEST_STORAGE_KEY, null);
          setError(nextError);
        }
      });
    }
    return () => { cancelled = true; };
  }, [open, refreshImport, refreshScan]);

  useEffect(() => {
    stopPoll(scanPollRef);
    if (!open || !scan || !activeScanStatuses.has(scan.status)) return;
    scanPollRef.current = window.setInterval(() => {
      void refreshScan(scan.scanId).catch(setError);
    }, POLL_INTERVAL_MS);
    return () => stopPoll(scanPollRef);
  }, [open, refreshScan, scan, stopPoll]);

  useEffect(() => {
    stopPoll(importPollRef);
    if (!open || !importRequest || !activeImportStatuses.has(importRequest.status)) return;
    importPollRef.current = window.setInterval(() => {
      void refreshImport(importRequest.importRequestId).catch(setError);
    }, POLL_INTERVAL_MS);
    return () => stopPoll(importPollRef);
  }, [importRequest, open, refreshImport, stopPoll]);

  useEffect(() => () => {
    stopPoll(scanPollRef);
    stopPoll(importPollRef);
  }, [stopPoll]);

  const startScan = useCallback(async (body: CncTelegramImportScanRequest) => {
    setError(null);
    setCandidates([]);
    setPrepared(null);
    setImportRequest(null);
    const next = await cncTelegramImportApi.createScan(body, createCncTelegramImportIdempotencyKey('cnc-telegram-scan'));
    setScan(next);
    writeStoredId(ACTIVE_SCAN_STORAGE_KEY, next.scanId);
    return next;
  }, []);

  const prepareImport = useCallback(async (candidateIds: string[]) => {
    if (!scan) throw new Error('Scan is not ready');
    const next = await cncTelegramImportApi.prepare(
      scan.scanId,
      { candidateIds },
      createCncTelegramImportIdempotencyKey('cnc-telegram-import-prepare'),
    );
    setPrepared(next);
    setCandidates(next.candidates.length > 0 ? next.candidates : candidates);
    return next;
  }, [candidates, scan]);

  const prepareRepeat = useCallback(async (importRequestId: string, candidateIds: string[]) => {
    const next = await cncTelegramImportApi.prepareRepeat(
      importRequestId,
      candidateIds,
      createCncTelegramImportIdempotencyKey('cnc-telegram-import-repeat'),
    );
    setPrepared(next);
    setImportRequest(null);
    return next;
  }, []);

  const confirmImport = useCallback(async (acknowledgements: Array<{ candidateId: string; duplicateAcknowledged: boolean }>) => {
    if (!prepared) throw new Error('Import is not prepared');
    const next = await cncTelegramImportApi.confirm(prepared.importRequestId, {
      confirmationId: prepared.confirmationId,
      duplicateAcknowledgements: acknowledgements,
    });
    setImportRequest(next);
    writeStoredId(ACTIVE_REQUEST_STORAGE_KEY, next.importRequestId);
    return next;
  }, [prepared]);

  const reconfirmImport = useCallback(async (request: CncTelegramImportRequest) => {
    const next = await cncTelegramImportApi.confirm(request.importRequestId, {
      confirmationId: request.confirmationId,
      duplicateAcknowledgements: request.items.map((item) => ({
        candidateId: item.candidateId,
        duplicateAcknowledged: item.duplicateAcknowledged || item.matches.length > 0,
      })),
    });
    setImportRequest(next);
    writeStoredId(ACTIVE_REQUEST_STORAGE_KEY, next.importRequestId);
    return next;
  }, []);

  return {
    scan,
    candidates,
    importRequest,
    prepared,
    loadingCandidates,
    error,
    startScan,
    prepareImport,
    confirmImport,
    reconfirmImport,
    prepareRepeat,
    refreshScan,
    refreshImport,
  };
}
