export interface FitBoxInput {
  naturalWidth: number;
  naturalHeight: number;
  containerWidth: number;
  containerHeight: number;
  paddingX?: number;
  paddingY?: number;
  zoom?: number;
  mode?: 'contain' | 'width';
}

export interface FitBoxResult {
  baseWidth: number;
  baseHeight: number;
  displayWidth: number;
  displayHeight: number;
  fitScale: number;
  zoom: number;
}

/**
 * Computes balanced natural display dimensions for a comic page inside an available viewport.
 * - Large, tall-portrait, or wide-landscape images scale down proportionally to fit completely inside the viewport.
 * - Small images stay at their natural 1:1 pixel dimensions (fitScale <= 1) rather than being forcibly upscaled.
 * - Zoom (default 1) scales evenly around the balanced base size and resets cleanly back to 1.
 */
export function computeNaturalFitSize({
  naturalWidth,
  naturalHeight,
  containerWidth,
  containerHeight,
  paddingX = 24,
  paddingY = 24,
  zoom = 1,
  mode = 'contain',
}: FitBoxInput): FitBoxResult {
  const safeNatW = Math.max(1, Number.isFinite(naturalWidth) ? naturalWidth : 900);
  const safeNatH = Math.max(1, Number.isFinite(naturalHeight) ? naturalHeight : 1200);
  const safeZoom = Math.max(0.25, Math.min(4, Number.isFinite(zoom) ? zoom : 1));

  const availW = Math.max(120, (Number.isFinite(containerWidth) && containerWidth > 0 ? containerWidth : 900) - paddingX * 2);
  const availH = Math.max(120, (Number.isFinite(containerHeight) && containerHeight > 0 ? containerHeight : 720) - paddingY * 2);

  const scaleX = availW / safeNatW;
  const scaleY = availH / safeNatH;

  const fitScale =
    mode === 'width'
      ? Math.min(scaleX, 1)
      : Math.min(scaleX, scaleY, 1);

  const effectiveScale = fitScale * safeZoom;
  const baseWidth = Math.max(1, Math.round(safeNatW * fitScale));
  const baseHeight = Math.max(1, Math.round(safeNatH * fitScale));

  return {
    baseWidth,
    baseHeight,
    displayWidth: Math.max(1, Math.round(safeNatW * effectiveScale)),
    displayHeight: Math.max(1, Math.round(safeNatH * effectiveScale)),
    fitScale,
    zoom: safeZoom,
  };
}
