/** Evidence meaning is determined by the originating aggregate, not an arbitrary
 * stage string. Membership is identity/scope only, including on order receipts;
 * it never supplies physical stock or quantity credit. */
export function isMdfEvidenceContract(kind: string,stage: string,evidence: string): boolean {
  if (!['packet','bazisCutSet','bath','order','orderDetail'].includes(kind)) return false;
  if (stage==='membership') return evidence==='derived';
  if (kind==='order' || kind==='orderDetail') return evidence==='declaration' && ['cut','laminated'].includes(stage);
  return (evidence==='physical' || evidence==='declaration')
    && (kind==='bath' ? stage==='laminated' : stage==='cut');
}
