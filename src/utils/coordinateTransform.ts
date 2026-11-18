import type { BoundingBox, FontSettings, Point } from '../types/domain';

export interface ContainRect {
  scale: number;
  offsetX: number;
  offsetY: number;
  contentWidth: number;
  contentHeight: number;
}

export interface ElementRectLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Computes the exact rendered content rectangle for an image/canvas rendered
 * with `object-fit: contain` inside a box of size (boxWidth x boxHeight),
 * taking the original image dimensions (naturalWidth x naturalHeight) as the canonical reference.
 */
export function computeContainRect(
  naturalWidth: number,
  naturalHeight: number,
  boxWidth: number,
  boxHeight: number
): ContainRect {
  const natW = Math.max(1, Number.isFinite(naturalWidth) ? naturalWidth : 1);
  const natH = Math.max(1, Number.isFinite(naturalHeight) ? naturalHeight : 1);
  const boxW = Math.max(1, Number.isFinite(boxWidth) ? boxWidth : 1);
  const boxH = Math.max(1, Number.isFinite(boxHeight) ? boxHeight : 1);

  const scale = Math.min(boxW / natW, boxH / natH);
  const contentWidth = natW * scale;
  const contentHeight = natH * scale;
  const offsetX = (boxW - contentWidth) / 2;
  const offsetY = (boxH - contentHeight) / 2;

  return {
    scale,
    offsetX,
    offsetY,
    contentWidth,
    contentHeight,
  };
}

/**
 * Converts canonical normalized coordinates (0..1000 relative to original image)
 * into image pixel coordinates.
 */
export function normalizedPointToImagePx(point: Point, imageWidth: number, imageHeight: number): Point {
  return {
    x: (point.x / 1000) * imageWidth,
    y: (point.y / 1000) * imageHeight,
  };
}

export function normalizedBoxToImagePx(
  box: BoundingBox,
  imageWidth: number,
  imageHeight: number
): BoundingBox {
  return {
    x: (box.x / 1000) * imageWidth,
    y: (box.y / 1000) * imageHeight,
    width: (box.width / 1000) * imageWidth,
    height: (box.height / 1000) * imageHeight,
  };
}

/**
 * Converts image pixel coordinates into canonical normalized coordinates (0..1000).
 */
export function imagePxToNormalizedPoint(point: Point, imageWidth: number, imageHeight: number): Point {
  const w = Math.max(1, imageWidth);
  const h = Math.max(1, imageHeight);
  return {
    x: Math.max(0, Math.min(1000, (point.x / w) * 1000)),
    y: Math.max(0, Math.min(1000, (point.y / h) * 1000)),
  };
}

/**
 * Converts normalized 0..1000 coordinates into display CSS pixel coordinates inside a box
 * rendered with `object-fit: contain`.
 */
export function normalizedPointToDisplayPx(
  point: Point,
  naturalWidth: number,
  naturalHeight: number,
  boxWidth: number,
  boxHeight: number
): Point {
  const contain = computeContainRect(naturalWidth, naturalHeight, boxWidth, boxHeight);
  return {
    x: contain.offsetX + (point.x / 1000) * contain.contentWidth,
    y: contain.offsetY + (point.y / 1000) * contain.contentHeight,
  };
}

export function normalizedBoxToDisplayPx(
  box: BoundingBox,
  naturalWidth: number,
  naturalHeight: number,
  boxWidth: number,
  boxHeight: number
): BoundingBox {
  const contain = computeContainRect(naturalWidth, naturalHeight, boxWidth, boxHeight);
  return {
    x: contain.offsetX + (box.x / 1000) * contain.contentWidth,
    y: contain.offsetY + (box.y / 1000) * contain.contentHeight,
    width: (box.width / 1000) * contain.contentWidth,
    height: (box.height / 1000) * contain.contentHeight,
  };
}

/**
 * Inverse-maps a pointer/client coordinate inside an `object-fit: contain` element rect
 * back into canonical normalized 0..1000 image coordinates.
 * Works identically under zoom, CSS pan transform, window resize, and RTL/LTR UI direction.
 */
export function displayClientToNormalized(
  clientX: number,
  clientY: number,
  elementRect: ElementRectLike,
  naturalWidth: number,
  naturalHeight: number
): Point {
  const contain = computeContainRect(
    naturalWidth,
    naturalHeight,
    elementRect.width,
    elementRect.height
  );
  const localX = clientX - elementRect.left - contain.offsetX;
  const localY = clientY - elementRect.top - contain.offsetY;
  const nx = (localX / Math.max(1e-6, contain.contentWidth)) * 1000;
  const ny = (localY / Math.max(1e-6, contain.contentHeight)) * 1000;
  return {
    x: Math.max(0, Math.min(1000, Math.round(nx))),
    y: Math.max(0, Math.min(1000, Math.round(ny))),
  };
}

/**
 * Converts a screen delta (dxPx, dyPx) into normalized 0..1000 delta relative to the contained image.
 */
export function displayDeltaToNormalized(
  dxPx: number,
  dyPx: number,
  elementRect: ElementRectLike,
  naturalWidth: number,
  naturalHeight: number
): { dx: number; dy: number } {
  const contain = computeContainRect(
    naturalWidth,
    naturalHeight,
    elementRect.width,
    elementRect.height
  );
  return {
    dx: (dxPx / Math.max(1e-6, contain.contentWidth)) * 1000,
    dy: (dyPx / Math.max(1e-6, contain.contentHeight)) * 1000,
  };
}

/**
 * Computes the geometric center of a region in normalized 0..1000 coordinates.
 * Uses the shoelace polygon centroid for valid 3+ vertex polygons and falls back to boundingBox center.
 */
export function computeRegionCenterNormalized(
  box: BoundingBox,
  polygon?: Point[]
): Point {
  if (polygon && polygon.length >= 3) {
    let doubleArea = 0;
    let cx = 0;
    let cy = 0;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const p0 = polygon[j];
      const p1 = polygon[i];
      const cross = p0.x * p1.y - p1.x * p0.y;
      doubleArea += cross;
      cx += (p0.x + p1.x) * cross;
      cy += (p0.y + p1.y) * cross;
    }
    if (Math.abs(doubleArea) > 1e-3) {
      return {
        x: cx / (3 * doubleArea),
        y: cy / (3 * doubleArea),
      };
    }
  }
  return {
    x: box.x + box.width / 2,
    y: box.y + box.height / 2,
  };
}

/**
 * Computes optical ink horizontal centering correction for `ctx.textAlign = 'center'`
 * so asymmetric font bearings or trailing punctuation don't bias inked glyphs off-center.
 */
export function computeOpticalCenterOffsetX(
  actualBoundingBoxLeft: number | undefined,
  actualBoundingBoxRight: number | undefined,
  fontSizePx: number
): number {
  if (
    typeof actualBoundingBoxLeft !== 'number' ||
    typeof actualBoundingBoxRight !== 'number' ||
    !Number.isFinite(actualBoundingBoxLeft) ||
    !Number.isFinite(actualBoundingBoxRight)
  ) {
    return 0;
  }
  // At x=0 with textAlign='center', ink spans [-actualBoundingBoxLeft, +actualBoundingBoxRight].
  // Shift by -(right - left)/2 = (left - right)/2 so ink midpoint lands on 0.
  const shift = (actualBoundingBoxLeft - actualBoundingBoxRight) / 2;
  const maxAllowed = Math.max(2, fontSizePx * 0.25);
  return Math.max(-maxAllowed, Math.min(maxAllowed, shift));
}

/**
 * Computes normalized anchor X offset inside a box respecting inner padding percentage.
 */
export function computeAlignedAnchorOffsetX(
  boxWidthPx: number,
  align: FontSettings['align'],
  paddingPct: number
): number {
  if (align === 'center') return 0;
  const padRatio = Math.min(0.32, Math.max(0.06, paddingPct / 100));
  const halfAvail = boxWidthPx * (0.5 - padRatio);
  return align === 'right' ? halfAvail : -halfAvail;
}
