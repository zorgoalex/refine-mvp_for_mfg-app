// Фонарик камеры сканера: подсветка бирки в тёмном цеху. Работает там, где камера
// объявляет `torch` в возможностях (Chrome на Android); на iOS Safari и ноутбуках
// возможности нет — кнопку не показываем.

type TorchTrack = Pick<MediaStreamTrack, 'applyConstraints'> & {
  getCapabilities?: () => MediaTrackCapabilities;
  readyState?: MediaStreamTrackState;
};

export function torchSupported(track: TorchTrack | null | undefined): boolean {
  if (!track || track.readyState === 'ended' || typeof track.getCapabilities !== 'function') return false;
  try {
    return (track.getCapabilities() as { torch?: unknown }).torch === true;
  } catch {
    return false;
  }
}

/** Включить/выключить; false — камера отказала (состояние кнопки не меняем). */
export async function setTorch(track: TorchTrack, on: boolean): Promise<boolean> {
  try {
    await track.applyConstraints({ advanced: [{ torch: on } as MediaTrackConstraintSet] });
    return true;
  } catch {
    return false;
  }
}
