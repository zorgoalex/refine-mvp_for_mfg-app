import { z } from 'zod';
import { authSession } from '../../api/authSession';
import { authStorage } from '../../utils/auth';
const cameraSchema = z.object({ x: z.number().finite(), y: z.number().finite(), zoom: z.number().min(.01).max(8) });
export type CadCamera = z.infer<typeof cameraSchema>;
function key(document: string) {
  const id = authSession.getUser()?.id ?? authStorage.getUser()?.id;
  return id == null ? null : `erp.cad.view.${id}.${document}`;
}
export function loadCamera(document: string): CadCamera | undefined {
  try { const k = key(document); const parsed = cameraSchema.safeParse(k ? JSON.parse(localStorage.getItem(k) ?? 'null') : null); return parsed.success ? parsed.data : undefined; } catch { return undefined; }
}
export function saveCamera(document: string, camera: CadCamera) {
  try { const k = key(document); if (k) localStorage.setItem(k, JSON.stringify(camera)); } catch { /* Private view persistence is optional, never blocks document work. */ }
}
const tabsSchema = z.object({ activeId: z.string().uuid().nullable(), openIds: z.array(z.string().uuid()).max(500) });
export function loadCadTabs(orderId: number): z.infer<typeof tabsSchema> | undefined {
  try { const k = key(`tabs:${orderId}`); const parsed = tabsSchema.safeParse(k ? JSON.parse(localStorage.getItem(k) ?? 'null') : null); return parsed.success ? parsed.data : undefined; } catch { return undefined; }
}
export function saveCadTabs(orderId: number, tabs: z.infer<typeof tabsSchema>) {
  try { const k = key(`tabs:${orderId}`); if (k && orderId > 0) localStorage.setItem(k, JSON.stringify(tabs)); } catch { /* Optional per-user presentation only. */ }
}
