import type { DatabaseClient } from '../../../database/database.types';
import { CNC_MDF_MATERIAL_MARKER_PATTERN_SOURCE as MDF, CNC_OTHER_MATERIAL_MARKER_PATTERN_SOURCE as OTHER,
  cncPacketCountsForMdfReadinessSql } from '../../../shared/cnc-material';

/** BASIS rows that establish MDF membership (mirror of `isMdfBazisEligibleRawRow`); $MDF/$OTHER are bound params. */
const bazisEligibleSql = (d: string, mdf: string, other: string) => `(${d}.cut_enabled IS TRUE AND ${d}.source_type='order_detail'
  AND ${d}.source_order_hdf_detail_id IS NULL AND ${d}.source_order_id IS NOT NULL AND ${d}.source_order_detail_id IS NOT NULL
  AND COALESCE(${d}.material_name,'') ~* ${mdf} AND COALESCE(${d}.material_name,'') !~* ${other})`;
/** Raw lines of a source at a position detached in that source (§5.4e) are history only. */
const notDetachedSql = (kind: string, id: string, order: string, detail: string) => `NOT EXISTS(SELECT 1
  FROM mdf_position_detachments x WHERE x.source_kind=${kind} AND x.source_id=${id} AND x.order_id=${order}
    AND x.detail_id=${detail})`;

/**
 * §5.6 presentation of published cards, read in the SAME read-only snapshot as the accounting. Nothing here decides a
 * card's existence, column, counters or readiness — those come from the publication. Rules:
 * - only orders visible to the actor (`allowed` CTE, $1 = user id) contribute items/progress/order names;
 * - card-level content that can reveal other orders (program/file names, previews, comments) only when EVERY owner is
 *   visible (`allOwnersAllowed`);
 * - composition-sensitive content (items with sizes, previews, program/file names) only when the accepted revision's
 *   presentation binding (migration 192) equals the current raw presentation digest, else `stale` (minimal card);
 * - live annotations (comments, rework, thumbs-up, completion, doweling links, BASIS name) are current-row values.
 */
export interface PublishedCardRef {
  kind: 'packet' | 'bazisCutSet' | 'bath'; id: string; acceptedRevision: string | null; allOwnersAllowed: boolean;
}
export interface PublishedPresentationItem {
  orderId: number; detailId: number | null; detailNumber: number | string | null;
  widthMm: number | null; heightMm: number | null; quantity: number;
}
export interface PublishedCardPresentation {
  kind: PublishedCardRef['kind']; id: string;
  /** Binding missing or raw composition changed since the accepted revision: render a minimal card. */
  stale: boolean;
  /** Composition-sensitive content; present only when not stale. `items` are limited to visible orders. */
  composition: null | {
    items: PublishedPresentationItem[];
    programName?: string | null; externalKey?: string | null; materialName?: string | null;
    hasSheetImage?: boolean; svgCutJobId?: number | null; svgCutResultId?: number | null;
    cuttingSequenceNo?: number | null; cutJobId?: number | null; cutJobName?: string | null;
    resultNo?: number | null; revisionNo?: number | null;
  };
  /** Live annotations (current values; not bound to the accepted revision). Present only for fully visible cards. */
  live: null | {
    comments?: unknown; rework?: boolean; thumbsUp?: boolean; completionStatus?: string | null;
    dowelingLinks?: unknown; name?: string | null;
  };
}
export interface PublishedCardProgress {
  kind: string; id: string; orderId: number; detailId: number; member: number; cut: number; laminated: number;
}
export interface PublishedOrderName { orderId: number; orderName: string }
export interface PublishedUnregisteredSource {
  kind: 'packet' | 'bazisCutSet'; id: string; displayName: string; sourceCreatedAt: string; orderIds: number[];
}

export async function loadMdfPublishedPresentation(tx: DatabaseClient, owners: string, userId: string,
  cards: readonly PublishedCardRef[], ownerIds: readonly number[]) {
  const kinds = cards.map(c => c.kind), ids = cards.map(c => c.id), revisions = cards.map(c => c.acceptedRevision);
  // Binding: the accepted revision's digest vs the current raw digest (one set-based read).
  // ...AND the normalized raw membership (eligible, non-detached rows aggregated per position) equals the published
  // members of the card (all owners, before redaction). Baths: cut results are immutable; no raw item rows.
  const bindings = new Map((await tx.query<{ kind: string; id: string; ok: boolean }>(`
    WITH s AS (SELECT * FROM unnest($1::text[],$2::text[],$3::text[]) s(kind,id,revision)),
    -- Native-typed keys so the raw joins use the (packet_id)/(bazis_cut_set_id, …) indexes; malformed ids match nothing.
    sp AS (SELECT id,id::uuid pid FROM s WHERE kind='packet'
      AND id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
    sb AS (SELECT id,id::bigint bid FROM s WHERE kind='bazisCutSet' AND id ~ '^[1-9][0-9]{0,17}$'),
    raw AS (
      SELECT 'packet'::text kind,sp.id,i.match_order_id order_id,i.match_detail_id detail_id,sum(i.quantity) q
        FROM cnc_telegram_packet_items i JOIN sp ON sp.pid=i.packet_id
        WHERE i.match_order_id IS NOT NULL AND i.match_detail_id IS NOT NULL
          AND ${notDetachedSql("'packet'", 'i.packet_id::text', 'i.match_order_id', 'i.match_detail_id')}
        GROUP BY 1,2,3,4
      UNION ALL
      SELECT 'bazisCutSet',sb.id,d.source_order_id,d.source_order_detail_id,sum(d.quantity)
        FROM bazis_cut_set_details d JOIN sb ON sb.bid=d.bazis_cut_set_id
        WHERE ${bazisEligibleSql('d', '$4', '$5')}
          AND ${notDetachedSql("'bazisCutSet'", 'd.bazis_cut_set_id::text', 'd.source_order_id', 'd.source_order_detail_id')}
        GROUP BY 1,2,3,4),
    pub AS (SELECT m.source_kind kind,m.source_id id,m.order_id,m.detail_id,sum(m.quantity) q
        FROM mdf_published_source_members m JOIN s ON s.kind=m.source_kind AND s.id=m.source_id GROUP BY 1,2,3,4),
    -- §5.8: one canonical (sorted) membership array per source, compared once — rows are unique per (order, detail)
    -- after GROUP BY, so array equality is exactly the former symmetric-EXCEPT set equality, without per-card scans.
    raw_agg AS (SELECT kind,id,jsonb_agg(jsonb_build_array(order_id,detail_id,q) ORDER BY order_id,detail_id,q) arr
      FROM raw GROUP BY kind,id),
    pub_agg AS (SELECT kind,id,jsonb_agg(jsonb_build_array(order_id,detail_id,q) ORDER BY order_id,detail_id,q) arr
      FROM pub GROUP BY kind,id)
    SELECT s.kind,s.id,(b.presentation_digest IS NOT NULL
        AND b.presentation_digest=mdf_source_presentation_digest(s.kind,s.id)
        AND (s.kind='bath' OR COALESCE(ra.arr,'[]'::jsonb)=COALESCE(pa.arr,'[]'::jsonb))) ok
    FROM s LEFT JOIN mdf_revision_presentation b ON b.source_kind=s.kind AND b.source_id=s.id AND b.revision_key=s.revision
      LEFT JOIN raw_agg ra ON ra.kind=s.kind AND ra.id=s.id
      LEFT JOIN pub_agg pa ON pa.kind=s.kind AND pa.id=s.id`,
  [kinds, ids, revisions, MDF, OTHER])).rows.map(r => [`${r.kind}:${r.id}`, r.ok]));

  const packetIds = cards.filter(c => c.kind === 'packet').map(c => c.id);
  const packets = new Map((await tx.query<{ id: string; programName: string | null; externalKey: string | null;
    materialName: string | null; hasSheetImage: boolean; svgCutJobId: number | null; svgCutResultId: number | null;
    cuttingSequenceNo: number | null; comments: unknown; rework: boolean; thumbsUp: boolean;
    completionStatus: string | null; dowelingLinks: unknown }>(`SELECT p.packet_id::text id,p.program_name "programName",
      p.external_packet_key "externalKey",p.material_name "materialName",(p.sheet_image_storage_key IS NOT NULL) "hasSheetImage",
      p.svg_cut_job_id::float8 "svgCutJobId",p.svg_cut_result_id::float8 "svgCutResultId",
      p.cutting_sequence_no::float8 "cuttingSequenceNo",p.comments_json comments,p.rework,p.thumbs_up "thumbsUp",
      p.completion_status "completionStatus",p.doweling_links_json "dowelingLinks"
    FROM cnc_telegram_packets p WHERE p.packet_id::text=ANY($1::text[])`, [packetIds])).rows.map(r => [r.id, r]));
  const packetItems = (await tx.query<PublishedPresentationItem & { id: string }>(`WITH allowed AS (${owners})
    SELECT i.packet_id::text id,i.match_order_id::float8 "orderId",i.match_detail_id::float8 "detailId",
      i.detail_number "detailNumber",i.width_mm::float8 "widthMm",i.height_mm::float8 "heightMm",i.quantity::float8 quantity
    FROM cnc_telegram_packet_items i JOIN allowed a ON a.order_id=i.match_order_id
    WHERE i.packet_id::text=ANY($2::text[]) AND i.match_detail_id IS NOT NULL
      AND ${notDetachedSql("'packet'", 'i.packet_id::text', 'i.match_order_id', 'i.match_detail_id')}
    ORDER BY i.packet_id,i.source_item_key,i.packet_item_id`,
  [userId, packetIds])).rows;

  const setIds = cards.filter(c => c.kind === 'bazisCutSet').map(c => c.id);
  const sets = new Map((await tx.query<{ id: string; name: string | null }>(`SELECT bazis_cut_set_id::text id,name
    FROM bazis_cut_sets WHERE bazis_cut_set_id::text=ANY($1::text[])`, [setIds])).rows.map(r => [r.id, r]));
  const setItems = (await tx.query<PublishedPresentationItem & { id: string }>(`WITH allowed AS (${owners})
    SELECT d.bazis_cut_set_id::text id,d.source_order_id::float8 "orderId",d.source_order_detail_id::float8 "detailId",
      d.position "detailNumber",d.cut_length_mm::float8 "widthMm",d.cut_width_mm::float8 "heightMm",d.quantity::float8 quantity
    FROM bazis_cut_set_details d JOIN allowed a ON a.order_id=d.source_order_id
    WHERE d.bazis_cut_set_id::text=ANY($2::text[]) AND ${bazisEligibleSql('d', '$3', '$4')}
      AND ${notDetachedSql("'bazisCutSet'", 'd.bazis_cut_set_id::text', 'd.source_order_id', 'd.source_order_detail_id')}
    ORDER BY d.bazis_cut_set_id,d.bazis_cut_set_detail_id`, [userId, setIds, MDF, OTHER])).rows;

  const bathIds = cards.filter(c => c.kind === 'bath').map(c => c.id);
  const baths = new Map((await tx.query<{ id: string; cutJobId: number; cutJobName: string | null; resultNo: number | null;
    revisionNo: number | null }>(`SELECT 'cut-result:'||r.cut_result_id::text id,r.cut_job_id::float8 "cutJobId",j.name "cutJobName",
      r.result_no::float8 "resultNo",r.revision_no::float8 "revisionNo"
    FROM cut_result r LEFT JOIN cut_job j ON j.cut_job_id=r.cut_job_id
    WHERE ('cut-result:'||r.cut_result_id::text)=ANY($1::text[])`, [bathIds])).rows.map(r => [r.id, r]));

  const presentation: PublishedCardPresentation[] = cards.map(card => {
    const bound = bindings.get(`${card.kind}:${card.id}`) === true;
    const full = card.allOwnersAllowed;
    if (card.kind === 'packet') {
      const p = packets.get(card.id);
      const items = packetItems.filter(i => i.id === card.id).map(({ id: _id, ...item }) => item);
      return { kind: card.kind, id: card.id, stale: !bound,
        composition: bound ? { items, ...(full && p ? { programName: p.programName, externalKey: p.externalKey,
          materialName: p.materialName, hasSheetImage: p.hasSheetImage, svgCutJobId: p.svgCutJobId,
          svgCutResultId: p.svgCutResultId, cuttingSequenceNo: p.cuttingSequenceNo } : {}) } : null,
        live: full && p ? { comments: p.comments, rework: p.rework, thumbsUp: p.thumbsUp,
          completionStatus: p.completionStatus, dowelingLinks: p.dowelingLinks } : null };
    }
    if (card.kind === 'bazisCutSet') {
      const items = setItems.filter(i => i.id === card.id).map(({ id: _id, ...item }) => item);
      return { kind: card.kind, id: card.id, stale: !bound, composition: bound ? { items } : null,
        live: full ? { name: sets.get(card.id)?.name ?? null } : null };
    }
    const b = baths.get(card.id);
    return { kind: card.kind, id: card.id, stale: !bound,
      composition: bound ? { items: [], ...(full && b ? { cutJobId: b.cutJobId, cutJobName: b.cutJobName,
        resultNo: b.resultNo, revisionNo: b.revisionNo } : {}) } : null, live: null };
  });

  // Source-specific progress: this card's own accepted lines, visible orders only, detached positions excluded.
  const progress = (await tx.query<PublishedCardProgress>(`WITH allowed AS (${owners})
    SELECT l.source_kind kind,l.source_id id,l.order_id::float8 "orderId",l.detail_id::float8 "detailId",
      COALESCE(sum(l.quantity) FILTER (WHERE l.stage_code='membership'),0)::float8 member,
      -- Same coverage as the engine's stageCoverage(): max(sum(physical), max(declaration)) — overlapping proof never adds.
      GREATEST(COALESCE(sum(l.quantity) FILTER (WHERE l.stage_code='cut' AND l.evidence_kind='physical'),0),
        COALESCE(max(l.quantity) FILTER (WHERE l.stage_code='cut' AND l.evidence_kind='declaration'),0))::float8 cut,
      GREATEST(COALESCE(sum(l.quantity) FILTER (WHERE l.stage_code='laminated' AND l.evidence_kind='physical'),0),
        COALESCE(max(l.quantity) FILTER (WHERE l.stage_code='laminated' AND l.evidence_kind='declaration'),0))::float8 laminated
    FROM unnest($2::text[],$3::text[],$4::text[]) s(kind,id,revision)
    JOIN mdf_evidence_revisions r ON r.source_kind=s.kind AND r.source_id=s.id AND r.revision_key=s.revision
    JOIN mdf_evidence_lines l ON l.source_kind=s.kind AND l.source_id=s.id AND l.revision_key=s.revision
    JOIN allowed a ON a.order_id=l.order_id
    -- Only detachments already applied to THIS published revision (recorded with it or before it): a confirmed
    -- correction whose successor is not yet published never changes the counters of the current publication.
    WHERE NOT l.rework AND NOT EXISTS(SELECT 1 FROM mdf_position_detachments x WHERE x.source_kind=l.source_kind
      AND x.source_id=l.source_id AND x.order_id=l.order_id AND x.detail_id=l.detail_id AND x.created_at<=r.created_at)
    GROUP BY 1,2,3,4 ORDER BY 1,2,3,4 LIMIT 20001`, [userId, kinds, ids, revisions])).rows;

  const orders = (await tx.query<PublishedOrderName>(`WITH allowed AS (${owners})
    SELECT o.order_id::float8 "orderId",o.order_name "orderName" FROM orders o JOIN allowed a USING(order_id)
    WHERE o.order_id=ANY($2::bigint[]) ORDER BY o.order_id`, [userId, [...new Set(ownerIds)]])).rows;
  return { presentation, progress, orders };
}

/** Authorized sources of the window not yet registered in the engine (no source head), MDF material, every owner
 * visible. Absence from the publication alone never lands a card here. */
export async function loadMdfUnregisteredSources(tx: DatabaseClient, owners: string, userId: string,
  window: { dateFrom: string; dateTo: string }): Promise<PublishedUnregisteredSource[]> {
  return (await tx.query<PublishedUnregisteredSource>(`WITH allowed AS (${owners}), packets AS (
      SELECT 'packet'::text kind,p.packet_id::text id,COALESCE(p.program_name,p.external_packet_key,p.packet_id::text) "displayName",
        COALESCE(p.source_created_at,p.created_at) created,
        ARRAY(SELECT DISTINCT i.match_order_id FROM cnc_telegram_packet_items i
          WHERE i.packet_id=p.packet_id AND i.match_order_id IS NOT NULL ORDER BY 1) owners
      FROM cnc_telegram_packets p
      WHERE COALESCE(p.source_created_at,p.created_at) >= $2::date AND COALESCE(p.source_created_at,p.created_at) < $3::date+interval '1 day'
        AND p.mdf_board_hidden_at IS NULL AND ${cncPacketCountsForMdfReadinessSql('p')}
        -- Hashed set (heads are few, packets many): avoids a misestimated per-row nested anti-join.
        AND p.packet_id::text NOT IN (SELECT h.source_id FROM mdf_source_heads h WHERE h.source_kind='packet')
    ), sets AS (
      SELECT 'bazisCutSet'::text kind,s.bazis_cut_set_id::text id,COALESCE(s.name,s.bazis_cut_set_id::text) "displayName",
        s.created_at created,
        ARRAY(SELECT DISTINCT d.source_order_id FROM bazis_cut_set_details d
          WHERE d.bazis_cut_set_id=s.bazis_cut_set_id AND d.source_order_id IS NOT NULL ORDER BY 1) owners
      FROM bazis_cut_sets s
      WHERE s.created_at >= $2::date AND s.created_at < $3::date+interval '1 day'
        AND EXISTS(SELECT 1 FROM bazis_cut_set_details d WHERE d.bazis_cut_set_id=s.bazis_cut_set_id
          AND ${bazisEligibleSql('d', '$4', '$5')})
        AND s.bazis_cut_set_id::text NOT IN (SELECT h.source_id FROM mdf_source_heads h WHERE h.source_kind='bazisCutSet')
    )
    SELECT x.kind,x.id,x."displayName",x.created::text "sourceCreatedAt",
      ARRAY(SELECT o::float8 FROM unnest(x.owners) o) "orderIds"
    FROM (SELECT * FROM packets UNION ALL SELECT * FROM sets) x
    WHERE cardinality(x.owners)>0 AND NOT EXISTS(SELECT 1 FROM unnest(x.owners) o
      WHERE o NOT IN (SELECT order_id FROM allowed))
    ORDER BY x.created DESC,x.kind,x.id LIMIT 201`,
  [userId, window.dateFrom, window.dateTo, MDF, OTHER])).rows;
}
