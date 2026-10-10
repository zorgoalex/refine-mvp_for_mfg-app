import { z } from 'zod';
import { cleanClientScreenFrameTree, type ClientScreenFrameElement } from './clientScreenFrameTree';
import { CLIENT_SCREEN_CODES } from './clientScreenRegistry';

/**
 * What travels from the manager window to the customer window. Everything is display-ready text:
 * no ids of the order, no source objects. Row and group ids are opaque random strings issued by the
 * manager window for one presentation. The schema is strict on purpose: a message that carries
 * anything else is dropped by the customer window.
 */
export const CLIENT_SCREEN_TAB_KEYS = ['basic', 'details', 'hdf', 'dates', 'finance', 'services', 'requirements', 'cut', 'workshops', 'additional'] as const;
/** Tabs the customer sees whole, as an inert copy of the manager's tab, instead of ticked fields. */
export const CLIENT_SCREEN_FRAME_TAB_KEYS = ['cut', 'workshops', 'additional'] as const;
export type ClientScreenFrameTabKey = typeof CLIENT_SCREEN_FRAME_TAB_KEYS[number];
export const isClientScreenFrameTab = (key: string | null | undefined): key is ClientScreenFrameTabKey =>
  (CLIENT_SCREEN_FRAME_TAB_KEYS as readonly string[]).includes(key ?? '');
export type ClientScreenTabKey = typeof CLIENT_SCREEN_TAB_KEYS[number];

const code = z.enum(CLIENT_SCREEN_CODES);
const text = z.string().max(2000);
const label = z.string().max(200);
const opaqueId = z.string().regex(/^[a-z0-9]{6,32}$/);

const field = z.object({ code, label, value: text }).strict();

const table = z.object({
  columns: z.array(z.object({ code, label, align: z.enum(['left', 'right']) }).strict()).max(40),
  /** cells[i] belongs to columns[i]. */
  rows: z.array(z.object({ id: opaqueId, cells: z.array(text).max(40) }).strict()).max(5000),
  /** Present only when the manager groups the rows by a field the customer may see. */
  groups: z.array(z.object({ id: opaqueId, title: text, rowIds: z.array(opaqueId).max(5000) }).strict()).max(2000).optional(),
}).strict().refine((value) => value.rows.every((row) => row.cells.length === value.columns.length), {
  message: 'row width differs from the columns',
});

const dataAttributes = z.record(z.string().regex(/^data-[a-z0-9-]{1,60}$/), z.string().max(200))
  .refine((value) => Object.keys(value).length <= 20, { message: 'too many data attributes' });
const classes = z.string().max(1000);
/** Inline styles of the page root: the same rule as for a style attribute inside the tree. */
const rootStyle = z.string().max(4000).refine(
  (value) => cleanClientScreenFrameTree({ t: 'div', a: { style: value } })?.a?.style === value || value === '',
  { message: 'unsafe root style' },
);

/**
 * One whole tab as the manager sees it. The tree is checked by the same rules that built it (see
 * clientScreenFrameTree): no scripts, no links, no addresses — pictures are inline, styles are text.
 */
export const clientScreenFrameSchema = z.object({
  tab: z.enum(CLIENT_SCREEN_FRAME_TAB_KEYS),
  /**
   * The manager's window: the copy is laid out in a box of exactly this size, so that everything
   * that depends on the window (media queries, vw/vh) comes out as on the manager's screen.
   */
  viewport: z.object({ w: z.number().int().min(200).max(8000), h: z.number().int().min(200).max(8000) }).strict(),
  /** The visible part of the scrolled area the tab lives in (the window itself, or a scrolled panel). */
  port: z.object({ w: z.number().int().min(1).max(8000), h: z.number().int().min(1).max(8000) }).strict(),
  /** Where the tab stands in that scrolled area, and its size: only the tab is shown to the customer, scaled to fit. */
  left: z.number().int().min(0).max(200_000),
  top: z.number().int().min(0).max(200_000),
  width: z.number().int().min(200).max(8000),
  height: z.number().int().min(1).max(200_000),
  /** null — the tab is over the size limit and is reported as such instead of being cut. */
  tree: z.unknown().transform((value, context): ClientScreenFrameElement | null => {
    if (value === null) return null;
    const tree = cleanClientScreenFrameTree(value);
    if (!tree) {
      context.addIssue({ code: 'custom', message: 'not a frame tree' });
      return z.NEVER;
    }
    return tree;
  }),
  /**
   * Ancestors of the tab, outermost first: tag, classes, data attributes and the inline style (it
   * declares variables the tab's styles read). They give the tab nothing but matching selectors and
   * inherited values: on the customer's side they have no box.
   */
  shells: z.array(z.object({ tag: z.enum(['div', 'section', 'main', 'article', 'aside', 'span']), cls: classes, data: dataAttributes, style: rootStyle }).strict()).max(40),
  root: z.object({ htmlCls: classes, bodyCls: classes, htmlData: dataAttributes, bodyData: dataAttributes, htmlStyle: rootStyle, bodyStyle: rootStyle }).strict(),
  /** Text of the page's stylesheets. */
  styles: z.array(z.string().max(4_000_000)).max(600).refine((value) => value.reduce((sum, block) => sum + block.length, 0) <= 4_000_000, {
    message: 'styles are over the limit',
  }),
}).strict();

export type ClientScreenFrame = z.infer<typeof clientScreenFrameSchema>;

export const clientScreenSnapshotSchema = z.object({
  title: label,
  summary: z.array(field).max(40),
  tabs: z.array(z.object({ key: z.enum(CLIENT_SCREEN_TAB_KEYS), label, counter: z.string().max(20).optional() }).strict()).max(20),
  basic: z.array(field).max(40).optional(),
  dates: z.array(field).max(40).optional(),
  /** The HDF tab: its order-level values and the table of calculated HDF details. */
  hdf: z.object({ fields: z.array(field).max(40), table: table.optional() }).strict().optional(),
  finance: z.object({ fields: z.array(field).max(40), payments: table.optional() }).strict().optional(),
  details: table.optional(),
  services: table.optional(),
  /** The «Материалы» tab: the film table and the sheet material table, each present only when it has a ticked column. */
  requirements: z.object({ films: table.optional(), sheets: table.optional() }).strict().optional(),
  /** The whole-tab copy of the tab the manager is on (cut, workshops, additional), when that tab is ticked. */
  frame: clientScreenFrameSchema.optional(),
}).strict();

export const clientScreenUiSchema = z.object({
  /** The tab the customer sees: the manager's tab, or the last visible one when the manager is on a hidden tab. */
  tab: z.enum(CLIENT_SCREEN_TAB_KEYS).nullable(),
  focus: z.object({ code, rowId: opaqueId.optional() }).strict().nullable(),
  /** Values of the row the manager is editing right now, before they reach the saved draft. */
  editing: z.object({ rowId: opaqueId, values: z.array(z.object({ code, value: text }).strict()).max(40) }).strict().nullable(),
  /** `frameTop` — how far the area a whole-tab copy lives in is scrolled, in the manager's pixels. */
  scroll: z.object({ ratio: z.number().min(0).max(1), anchorRowId: opaqueId.optional(), frameTop: z.number().int().min(0).max(200_000).optional() }).strict().nullable(),
  /**
   * The manager's page of the detail table. `start`/`count` give the exact run of the customer's rows
   * that are on that page (the manager's page may also hold empty grid rows the customer never gets).
   */
  page: z.object({
    current: z.number().int().min(1).max(100000), size: z.number().int().min(1).max(1000),
    start: z.number().int().min(0).max(5000).optional(), count: z.number().int().min(0).max(1000).optional(),
  }).strict().nullable(),
}).strict();

export type ClientScreenSnapshot = z.infer<typeof clientScreenSnapshotSchema>;
export type ClientScreenUi = z.infer<typeof clientScreenUiSchema>;
export type ClientScreenField = z.infer<typeof field>;
export type ClientScreenTable = z.infer<typeof table>;
