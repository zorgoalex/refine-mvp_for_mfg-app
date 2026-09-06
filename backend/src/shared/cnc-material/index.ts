export const CNC_MDF_MATERIAL_MARKER_PATTERN_SOURCE =
  '(mdf|мдф)';

export const CNC_OTHER_MATERIAL_MARKER_PATTERN_SOURCE =
  '(^|[^a-zа-яё])(hdf|хдф|лдсп|ldsp|lдсп|дсп|dsp|двп|dvp|osb|осп|fanera|фанера|plywood|акрил|acrylic|пластик|plastic|khdf|xdf|osp|akril|plastik)([^a-zа-яё]|$)';

// Shared by board reads and detail-status automation. program_name is the CNC
// filename; a non-MDF marker overrides even the worker's default MDF material.
// Aliases are internal SQL identifiers, never request input.
export function cncPacketCountsForMdfReadinessSql(packetAlias: 'p' | 'packet'): string {
  return `(
    COALESCE(${packetAlias}.material_name, '') ~* '${CNC_MDF_MATERIAL_MARKER_PATTERN_SOURCE}'
    AND COALESCE(${packetAlias}.material_name, '') !~* '${CNC_OTHER_MATERIAL_MARKER_PATTERN_SOURCE}'
    AND COALESCE(${packetAlias}.program_name, '') !~* '${CNC_OTHER_MATERIAL_MARKER_PATTERN_SOURCE}'
    AND COALESCE(${packetAlias}.external_packet_key, '') !~* '${CNC_OTHER_MATERIAL_MARKER_PATTERN_SOURCE}'
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements_text(COALESCE(${packetAlias}.comments_json, '[]'::jsonb))
        AS material_comment(comment_text)
      WHERE material_comment.comment_text ~* '${CNC_OTHER_MATERIAL_MARKER_PATTERN_SOURCE}'
    )
  )`;
}
