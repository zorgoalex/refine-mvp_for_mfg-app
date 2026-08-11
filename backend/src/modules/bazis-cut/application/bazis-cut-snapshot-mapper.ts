import { bazisCutDetailFieldsSchema, type BazisCutDetailFields } from '../dto/bazis-cut.dto';
import { formatCutNumber } from '../../cut/application/cut-numbering';

export interface BazisCutSnapshotSource {
  materialName: string;
  thicknessMm: number;
  detailNumber: number;
  importedFromBazisProject: boolean;
  bazisProject: string | null;
  bazisOrder: string | null;
  bazisNodeDesignation: string | null;
  basisDesignation: string | null;
  basisData: string | null;
  detailName: string | null;
  heightMm: number;
  widthMm: number;
  quantity: number;
  note: string | null;
  milling: string | null;
  film: string | null;
  doweling: boolean;
  verticalTexture: boolean;
}

export interface BazisDocumentLabels {
  sourceBazisProjectName: string;
  sourceBazisOrderNo: string;
  sourceBazisProductName: string;
}

export function mapBazisCutSnapshotFields(source: BazisCutSnapshotSource): BazisCutDetailFields | null {
  const length = source.verticalTexture ? source.widthMm : source.heightMm;
  const width = source.verticalTexture ? source.heightMm : source.widthMm;
  const fields: BazisCutDetailFields = {
    cutEnabled: true, materialType: 'Площадной', materialName: source.materialName.trim(),
    materialArticle: '', thicknessMm: source.thicknessMm,
    position: buildBazisCutPosition(source),
    partName: firstNonEmpty(source.detailName, source.basisData?.split('/')[2], `Деталь ${source.detailNumber}`),
    finishedLengthMm: length, finishedWidthMm: width,
    cutLengthMm: roundTenth(length), cutWidthMm: roundTenth(width), quantity: source.quantity,
    orientation: 'Не задана', groove: '', l1Name: '', l1Designation: '', l1ThicknessMm: 0,
    l2Name: '', l2Designation: '', l2ThicknessMm: 0, w1Name: '', w1Designation: '',
    w1ThicknessMm: 0, w2Name: '', w2Designation: '', w2ThicknessMm: 0,
    priority: null, comment: source.note ?? '', customProperty: '', glue: '',
    milling: source.milling ?? '', route: source.doweling ? 'Присадка:' : '', film: source.film ?? '',
  };
  return bazisCutDetailFieldsSchema.safeParse(fields).success ? fields : null;
}

export function buildBazisCutPosition(
  source: Pick<BazisCutSnapshotSource,
    'detailNumber' | 'importedFromBazisProject' | 'bazisProject' | 'bazisOrder'
    | 'bazisNodeDesignation' | 'basisDesignation'>,
): string {
  if (source.importedFromBazisProject) {
    return source.bazisNodeDesignation?.trim() ?? '';
  }

  const designation = source.basisDesignation?.trim() ?? '';
  return designation && Boolean(source.bazisProject?.trim()) ? designation : String(source.detailNumber);
}

export function resolveErpOrderBazisLabels(input: {
  detailBazisProject: string | null;
  detailBazisProduct: string | null;
}): BazisDocumentLabels {
  const project = input.detailBazisProject?.trim() ?? '';
  return {
    sourceBazisProjectName: project,
    sourceBazisOrderNo: '',
    sourceBazisProductName: project ? input.detailBazisProduct?.trim() ?? '' : '',
  };
}

export function resolveBazisDetailLabels(input: {
  rootProductCount: number | null;
  productOrderNo: string | null;
  revisionBazisOrderNo: string | null;
  detailBazisProject: string | null;
  detailBazisProduct: string | null;
}): BazisDocumentLabels {
  const productOrderNo = input.productOrderNo?.trim() ?? '';
  const revisionBazisOrderNo = input.revisionBazisOrderNo?.trim() ?? '';
  const detailBazisProject = input.detailBazisProject?.trim() ?? '';
  const isBazisProject = (input.rootProductCount ?? 1) > 1;
  const unmatchedDocumentNumber = input.rootProductCount === null ? detailBazisProject : '';
  return {
    sourceBazisProjectName: isBazisProject
      ? revisionBazisOrderNo || productOrderNo
      : '',
    sourceBazisOrderNo: isBazisProject
      ? ''
      : productOrderNo || revisionBazisOrderNo || unmatchedDocumentNumber,
    sourceBazisProductName: input.detailBazisProduct?.trim() ?? '',
  };
}

export function buildBazisBathCutNumber(
  cutJobId: number | null | undefined,
  resultNo: number | null | undefined,
): string {
  return typeof cutJobId === 'number' && Number.isInteger(cutJobId) && cutJobId > 0
    && typeof resultNo === 'number' && Number.isInteger(resultNo) && resultNo > 0
    ? formatCutNumber(cutJobId, resultNo, true)
    : '';
}

function roundTenth(value: number): number {
  return Math.round((value + Number.EPSILON) * 10) / 10;
}

function firstNonEmpty(...values: Array<string | null | undefined>): string {
  return values.map((value) => value?.trim()).find((value): value is string => Boolean(value)) ?? '';
}
