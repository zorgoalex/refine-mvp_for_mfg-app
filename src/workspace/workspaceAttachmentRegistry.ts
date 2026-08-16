import { getWorkspaceStateNamespace } from './workspaceStateNamespace';

export type WorkspaceAttachmentKind = 'file' | 'blob' | 'parsed-workbook';

export interface RetainWorkspaceAttachmentInput<T extends object> {
  workspaceKey: string;
  attachmentKey: string;
  value: T;
  kind?: WorkspaceAttachmentKind;
  estimatedBytes?: number;
}

interface WorkspaceAttachmentRecord<T extends object = object> {
  value: T;
  kind: WorkspaceAttachmentKind;
  sizeBytes: number;
  retainedAt: number;
}

const MAX_ATTACHMENTS_PER_NAMESPACE = 16;
const MAX_ATTACHMENT_BYTES = 64 * 1024 * 1024;
const MAX_NAMESPACE_ATTACHMENT_BYTES = 128 * 1024 * 1024;
const attachmentsByNamespace = new Map<
  string,
  Map<string, Map<string, WorkspaceAttachmentRecord>>
>();

export function retainWorkspaceAttachment<T extends object>(
  input: RetainWorkspaceAttachmentInput<T>,
  namespace = getWorkspaceStateNamespace(),
): boolean {
  const kind = input.kind ?? inferAttachmentKind(input.value);
  const sizeBytes = resolveAttachmentSize(input.value, kind, input.estimatedBytes);
  if (sizeBytes < 0 || sizeBytes > MAX_ATTACHMENT_BYTES) return false;

  const scoped = getNamespaceMap(namespace);
  let workspace = scoped.get(input.workspaceKey);
  if (!workspace) {
    workspace = new Map();
    scoped.set(input.workspaceKey, workspace);
  }
  const existing = workspace.get(input.attachmentKey);
  const diagnostics = getWorkspaceAttachmentDiagnostics(namespace);
  const nextCount = diagnostics.count + (existing ? 0 : 1);
  const nextBytes = diagnostics.bytes - (existing?.sizeBytes ?? 0) + sizeBytes;
  if (nextCount > MAX_ATTACHMENTS_PER_NAMESPACE || nextBytes > MAX_NAMESPACE_ATTACHMENT_BYTES) {
    if (workspace.size === 0) scoped.delete(input.workspaceKey);
    if (scoped.size === 0) attachmentsByNamespace.delete(namespace);
    return false;
  }

  workspace.set(input.attachmentKey, {
    value: input.value,
    kind,
    sizeBytes,
    retainedAt: Date.now(),
  });
  return true;
}

export function readWorkspaceAttachment<T extends object>(
  workspaceKey: string,
  attachmentKey: string,
  namespace = getWorkspaceStateNamespace(),
): T | null {
  return (attachmentsByNamespace
    .get(namespace)
    ?.get(workspaceKey)
    ?.get(attachmentKey)
    ?.value as T | undefined) ?? null;
}

export function releaseWorkspaceAttachment(
  workspaceKey: string,
  attachmentKey: string,
  namespace = getWorkspaceStateNamespace(),
): void {
  const scoped = attachmentsByNamespace.get(namespace);
  const workspace = scoped?.get(workspaceKey);
  workspace?.delete(attachmentKey);
  if (workspace?.size === 0) scoped?.delete(workspaceKey);
  if (scoped?.size === 0) attachmentsByNamespace.delete(namespace);
}

export function releaseWorkspaceAttachments(
  workspaceKey: string,
  namespace = getWorkspaceStateNamespace(),
): void {
  const scoped = attachmentsByNamespace.get(namespace);
  scoped?.delete(workspaceKey);
  if (scoped?.size === 0) attachmentsByNamespace.delete(namespace);
}

export function clearWorkspaceAttachments(namespace?: string): void {
  if (namespace) attachmentsByNamespace.delete(namespace);
  else attachmentsByNamespace.clear();
}

export function getWorkspaceAttachmentDiagnostics(namespace?: string): {
  namespaces: number;
  count: number;
  bytes: number;
} {
  let count = 0;
  let bytes = 0;
  const scopes = namespace
    ? [attachmentsByNamespace.get(namespace)].filter(Boolean)
    : [...attachmentsByNamespace.values()];
  scopes.forEach((scoped) => scoped?.forEach((workspace) => workspace.forEach((record) => {
    count += 1;
    bytes += record.sizeBytes;
  })));
  return { namespaces: attachmentsByNamespace.size, count, bytes };
}

function getNamespaceMap(
  namespace: string,
): Map<string, Map<string, WorkspaceAttachmentRecord>> {
  let scoped = attachmentsByNamespace.get(namespace);
  if (!scoped) {
    scoped = new Map();
    attachmentsByNamespace.set(namespace, scoped);
  }
  return scoped;
}

function inferAttachmentKind(value: object): WorkspaceAttachmentKind {
  if (typeof File !== 'undefined' && value instanceof File) return 'file';
  if (typeof Blob !== 'undefined' && value instanceof Blob) return 'blob';
  return 'parsed-workbook';
}

function resolveAttachmentSize(
  value: object,
  kind: WorkspaceAttachmentKind,
  estimatedBytes: number | undefined,
): number {
  if ((kind === 'file' || kind === 'blob') && typeof Blob !== 'undefined' && value instanceof Blob) {
    return value.size;
  }
  return typeof estimatedBytes === 'number' && Number.isSafeInteger(estimatedBytes)
    ? estimatedBytes
    : -1;
}
