export interface BazisCutSavePickerOptions {
  suggestedName: string;
  types: Array<{ description: string; accept: Record<string, string[]> }>;
}

export interface BazisCutSaveHandle {
  createWritable(): Promise<{ write(data: Blob): Promise<void>; close(): Promise<void> }>;
}

interface SaveInput {
  suggestedName: string;
  picker?: (options: BazisCutSavePickerOptions) => Promise<BazisCutSaveHandle>;
  fetchFile: () => Promise<{ blob: Blob; fileName: string | null }>;
  fallbackDownload: (blob: Blob, fileName: string) => void;
  onGenerationStart?: () => void;
}

export async function saveBazisCutFile(input: SaveInput): Promise<void> {
  // Must execute before the first await so browser user activation is retained.
  const handle = input.picker ? await input.picker({
    suggestedName: input.suggestedName,
    types: [{ description: 'Excel 97–2003', accept: { 'application/vnd.ms-excel': ['.xls'] } }],
  }) : undefined;

  input.onGenerationStart?.();
  const file = await input.fetchFile();
  if (!handle) {
    input.fallbackDownload(file.blob, file.fileName || input.suggestedName);
    return;
  }
  const writable = await handle.createWritable();
  await writable.write(file.blob);
  await writable.close();
}
