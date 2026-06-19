const { parseSheetDimensions } = require('./dimensions');

// A name collision is only safe to reuse/dedup when the target is a usable spec IDENTICAL to what SP2
// would create. `target` is an existing DB row or a within-run planned row; `spec.thicknessMm/widthMm/
// heightMm` are the FULLY-RESOLVED dims SP2 would insert (parsed where the name yields a value, documented
// default otherwise). Fail closed on ANY of:
//  - target inactive (never bind materials to a hidden/retired spec)                         [Critic R3]
//  - material_type_id / unit_id mismatch
//  - provenance mismatch: supplier_id (from default_supplier_id) / vendor_id / ref_key_1c     [Critic R2]
//  - ANY dimension differs from the parse-else-default spec SP2 would have created            [Critic R8]
//  - any non-NULL supplier_article / texture / color (SP2 writes NULL)                        [Critic R9]
function compatible(target, spec) {
  if (target.isActive === false) return false;
  if (target.materialTypeId !== spec.materialTypeId) return false;
  if (target.unitId !== spec.unitId) return false;
  if ((target.supplierId ?? null) !== (spec.supplierId ?? null)) return false;
  if ((target.vendorId ?? null) !== (spec.vendorId ?? null)) return false;
  if ((target.refKey1c ?? null) !== (spec.refKey1c ?? null)) return false;
  if (Number(target.thicknessMm) !== spec.thicknessMm) return false;
  if (Number(target.widthMm) !== spec.widthMm) return false;
  if (Number(target.heightMm) !== spec.heightMm) return false;
  if ((target.supplierArticle ?? null) !== (spec.supplierArticle ?? null)) return false;
  if ((target.texture ?? null) !== (spec.texture ?? null)) return false;
  if ((target.color ?? null) !== (spec.color ?? null)) return false;
  return true;
}
const describeSpec = (s) => `type=${s.materialTypeId},unit=${s.unitId},supplier=${s.supplierId ?? null},vendor=${s.vendorId ?? null},ref=${s.refKey1c ?? null},dims=${s.thicknessMm}/${s.widthMm}/${s.heightMm},active=${s.isActive ?? true}`;

// The sheet spec SP2 would create for a material (supplier maps from default_supplier_id; dims parse-else-
// default; supplier_article/texture/color always NULL; active). Exported so the runner can recompute it to
// RE-VALIDATE a link target locked at link time.
function materialToSpec(m) {
  const dims = parseSheetDimensions(m.materialName);
  return {
    materialTypeId: m.materialTypeId, unitId: m.unitId,
    supplierId: m.defaultSupplierId ?? null, vendorId: m.vendorId ?? null, refKey1c: m.refKey1c ?? null,
    thicknessMm: dims.thicknessMm, widthMm: dims.widthMm, heightMm: dims.heightMm, dimsParsed: dims.parsed,
    supplierArticle: null, texture: null, color: null, isActive: true,
  };
}

function buildSheetCopyPlan({ materials, existingSheetTypesByName, materialTypeAllowlist }) {
  const allow = new Set(materialTypeAllowlist);
  const existing = existingSheetTypesByName instanceof Map ? existingSheetTypesByName : new Map();
  const inserts = [], links = [], skipped = [], conflicts = [];
  const plannedByName = new Map();   // name -> spec planned this run

  for (const m of materials) {
    if (!m.isActive) { skipped.push({ materialId: m.materialId, reason: 'inactive' }); continue; }
    if (!allow.has(m.materialTypeId)) { skipped.push({ materialId: m.materialId, reason: 'type-not-allowed' }); continue; }
    if (m.sheetMaterialTypeId != null) { skipped.push({ materialId: m.materialId, reason: 'already-linked' }); continue; }

    const name = m.materialName;
    const spec = materialToSpec(m);

    const existingRow = existing.get(name);
    if (existingRow) {
      if (!compatible(existingRow, spec)) {
        conflicts.push({ materialId: m.materialId, name, reason: 'existing-row-mismatch',
          detail: `existing(${describeSpec(existingRow)}) != material(${describeSpec(spec)})` });
        continue;
      }
      links.push({ materialId: m.materialId, name });
      continue;
    }

    const planned = plannedByName.get(name);
    if (planned) {
      if (!compatible(planned, spec)) {
        conflicts.push({ materialId: m.materialId, name, reason: 'within-run-mismatch',
          detail: `planned(${describeSpec(planned)}) != material(${describeSpec(spec)})` });
        continue;
      }
      links.push({ materialId: m.materialId, name });
      continue;
    }

    inserts.push({
      materialId: m.materialId, name,
      materialTypeId: spec.materialTypeId, unitId: spec.unitId,
      supplierId: spec.supplierId, vendorId: spec.vendorId, refKey1c: spec.refKey1c,
      thicknessMm: spec.thicknessMm, widthMm: spec.widthMm, heightMm: spec.heightMm, dimsParsed: spec.dimsParsed,
    });
    plannedByName.set(name, spec);
    links.push({ materialId: m.materialId, name });
  }

  return { inserts, links, skipped, conflicts };
}

// compatible + materialToSpec are exported so the runner can RE-VALIDATE inside the write transaction
// (source-material drift is caught instead by the optimistic identity-guarded link UPDATE — Critic R12).
module.exports = { buildSheetCopyPlan, compatible, materialToSpec };
