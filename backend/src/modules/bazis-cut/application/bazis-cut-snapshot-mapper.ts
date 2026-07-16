import { bazisCutDetailFieldsSchema, type BazisCutDetailFields } from '../dto/bazis-cut.dto';

export interface BazisCutSnapshotSource {
  materialName: string;
  thicknessMm: number;
  detailNumber: number;
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

export function mapBazisCutSnapshotFields(source: BazisCutSnapshotSource): BazisCutDetailFields | null {
  const length = source.verticalTexture ? source.widthMm : source.heightMm;
  const width = source.verticalTexture ? source.heightMm : source.widthMm;
  const fields: BazisCutDetailFields = {
    cutEnabled: true, materialType: 'Площадной', materialName: source.materialName.trim(),
    materialArticle: '', thicknessMm: source.thicknessMm,
    position: firstNonEmpty(source.basisDesignation, source.basisData?.split('/')[1], String(source.detailNumber)),
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

function roundTenth(value: number): number {
  return Math.round((value + Number.EPSILON) * 10) / 10;
}

function firstNonEmpty(...values: Array<string | null | undefined>): string {
  return values.map((value) => value?.trim()).find((value): value is string => Boolean(value)) ?? '';
}
