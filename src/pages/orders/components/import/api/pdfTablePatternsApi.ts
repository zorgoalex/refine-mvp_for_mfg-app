import { apiRoutes } from '../../../../../api/apiRoutes';
import { httpClient } from '../../../../../api/httpClient';
import type { PdfLayoutMapping, PdfLayoutSignature } from '../utils/pdfLayoutPattern';

export interface PdfTablePatternDto {
  id: number;
  fingerprint: string;
  signature: PdfLayoutSignature;
  mapping: PdfLayoutMapping;
  approvalStatus: 'pending' | 'approved' | 'rejected';
  isActive: boolean;
  version: number;
}

export interface PdfPatternMatch {
  index: number;
  fingerprint: string;
  status: 'exact' | 'none';
  requiresConfirmation: boolean;
  pattern: PdfTablePatternDto | null;
}

export const pdfTablePatternsApi = {
  async match(signatures: PdfLayoutSignature[]): Promise<PdfPatternMatch[]> {
    const response = await httpClient.post<{ results: PdfPatternMatch[] }>(
      apiRoutes.bazis.matchPdfTablePatterns,
      { signatures },
    );
    return response.results;
  },

  learn(signature: PdfLayoutSignature, mapping: PdfLayoutMapping): Promise<PdfTablePatternDto> {
    return httpClient.post<PdfTablePatternDto>(
      apiRoutes.bazis.pdfTablePatterns,
      { signature, mapping },
      { headers: { 'Idempotency-Key': crypto.randomUUID() } },
    );
  },

  approve(pattern: PdfTablePatternDto, mapping: PdfLayoutMapping): Promise<PdfTablePatternDto> {
    return httpClient.patch<PdfTablePatternDto>(
      apiRoutes.bazis.pdfTablePattern(pattern.fingerprint),
      { version: pattern.version, mapping, approvalStatus: 'approved' },
      { headers: { 'Idempotency-Key': crypto.randomUUID() } },
    );
  },
};
