/**
 * Geometric detail area in square metres, rounded to nearest 0.01 m².
 * Dimensions are millimetres. Invalid/non-positive dimensions produce zero.
 */
export function calculateOrderDetailArea(
  heightMm: number,
  widthMm: number,
  quantity: number,
): number {
  if (
    !Number.isFinite(heightMm) ||
    !Number.isFinite(widthMm) ||
    !Number.isFinite(quantity) ||
    heightMm <= 0 ||
    widthMm <= 0 ||
    quantity <= 0
  ) {
    return 0;
  }

  const areaMm2 = heightMm * widthMm * quantity;
  return roundAreaMm2(areaMm2);
}

export function calculateOrderTotalArea(
  details: ReadonlyArray<{
    height?: number | null;
    length?: number | null;
    width?: number | null;
    quantity?: number | null;
  }>,
): number {
  const totalAreaMm2 = details.reduce((sum, detail) => {
    const heightMm = Number(detail.height ?? detail.length);
    const widthMm = Number(detail.width);
    const quantity = Number(detail.quantity);

    if (
      !Number.isFinite(heightMm) ||
      !Number.isFinite(widthMm) ||
      !Number.isFinite(quantity) ||
      heightMm <= 0 ||
      widthMm <= 0 ||
      quantity <= 0
    ) {
      return sum;
    }

    return sum + heightMm * widthMm * quantity;
  }, 0);

  return roundAreaMm2(totalAreaMm2);
}

function roundAreaMm2(areaMm2: number): number {
  const hundredthsM2 = areaMm2 / 10_000;
  const tolerance = Number.EPSILON * Math.max(1, Math.abs(hundredthsM2));
  return Math.round(hundredthsM2 + tolerance) / 100;
}
