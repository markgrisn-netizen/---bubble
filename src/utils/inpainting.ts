import type { ManualStroke, Page, Point, TextRegion } from '../types/domain';
import { fitTextInRegion } from './bubbleLayout';
import {
  auditCleanedAndRenderedRegion,
  cleanRoiBufferInPlace,
  computeRegionRoiBounds,
  estimateInteriorFillColor,
  getSafeWidthAtBandY,
  segmentBubbleInterior,
  type BubbleSegmentationResult,
  type CoreBackgroundEstimate,
  type RegionQualityAudit,
} from './bubbleSegmentation';
import {
  computeAlignedAnchorOffsetX,
  computeOpticalCenterOffsetX,
  computeRegionCenterNormalized,
  normalizedBoxToImagePx,
} from './coordinateTransform';

export function sampleInteriorBackground(
  data: Uint8ClampedArray,
  bufW: number,
  bufH: number,
  _poly: Point[],
  minX: number,
  minY: number,
  maxX: number,
  maxY: number
): CoreBackgroundEstimate {
  return estimateInteriorFillColor(data, bufW, bufH, {
    x: minX,
    y: minY,
    width: Math.max(1, maxX - minX + 1),
    height: Math.max(1, maxY - minY + 1),
  });
}

export interface RegionCleanOutcome {
  seg: BubbleSegmentationResult;
  beforeRoiData: Uint8ClampedArray;
  afterRoiData: Uint8ClampedArray;
}

export interface RenderedRegionMetrics {
  textCenterPx: Point;
  textLines: Array<{ y: number; width: number; height: number }>;
  overflowed: boolean;
}

/**
 * Segments the true speech-bubble / caption-box interior in pixel space and removes
 * 100% of original letters, halos, and drop-shadows strictly within the interior mask
 * while leaving black outlines, balloon tails, and exterior artwork untouched.
 */
export function cleanAndSegmentRegionInPlace(
  ctx: CanvasRenderingContext2D,
  imgW: number,
  imgH: number,
  region: TextRegion,
  engine: 'telea_biharmonic' | 'solid_interior' | 'manual_only' = 'telea_biharmonic'
): RegionCleanOutcome | null {
  const { localBoxPx, pxPoly, roiX, roiY, roiW, roiH } = computeRegionRoiBounds(
    region,
    imgW,
    imgH
  );
  if (roiW <= 4 || roiH <= 4) return null;

  const imgData = ctx.getImageData(roiX, roiY, roiW, roiH);
  const beforeRoiData = new Uint8ClampedArray(imgData.data);

  const seg = segmentBubbleInterior(
    imgData.data,
    roiW,
    roiH,
    roiX,
    roiY,
    region.regionType,
    localBoxPx,
    pxPoly
  );

  if (region.cleanMode === 'auto' && engine !== 'manual_only') {
    cleanRoiBufferInPlace(imgData.data, seg, engine, pxPoly);
    ctx.putImageData(imgData, roiX, roiY);
  }

  return {
    seg,
    beforeRoiData,
    afterRoiData: new Uint8ClampedArray(imgData.data),
  };
}

/**
 * Backwards-compatible wrapper that performs true CV segmentation + interior cleaning in place.
 */
export function cleanRegionInPlace(
  ctx: CanvasRenderingContext2D,
  imgW: number,
  imgH: number,
  region: TextRegion,
  engine: 'telea_biharmonic' | 'solid_interior' | 'manual_only' = 'telea_biharmonic'
): void {
  if (region.cleanMode !== 'auto' || engine === 'manual_only') return;
  cleanAndSegmentRegionInPlace(ctx, imgW, imgH, region, engine);
}

/**
 * Applies manual brush & eraser strokes non-destructively over the cleaned canvas.
 */
export function applyManualStrokes(
  ctx: CanvasRenderingContext2D,
  originalImg: HTMLImageElement,
  imgW: number,
  imgH: number,
  strokes: ManualStroke[]
): void {
  if (!strokes.length) return;

  for (const stroke of strokes) {
    if (stroke.points.length === 0) continue;
    const pxSize = Math.max(4, (stroke.size / 1000) * imgW);

    if (stroke.tool === 'brush') {
      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.lineWidth = pxSize;
      ctx.strokeStyle = stroke.color || '#FFFFFF';
      ctx.beginPath();
      const first = stroke.points[0];
      ctx.moveTo((first.x / 1000) * imgW, (first.y / 1000) * imgH);
      for (let i = 1; i < stroke.points.length; i++) {
        ctx.lineTo((stroke.points[i].x / 1000) * imgW, (stroke.points[i].y / 1000) * imgH);
      }
      if (stroke.points.length === 1) {
        ctx.lineTo((first.x / 1000) * imgW + 0.5, (first.y / 1000) * imgH);
      }
      ctx.stroke();
      ctx.restore();
    } else if (stroke.tool === 'eraser') {
      ctx.save();
      ctx.beginPath();
      for (const pt of stroke.points) {
        const px = (pt.x / 1000) * imgW;
        const py = (pt.y / 1000) * imgH;
        ctx.moveTo(px + pxSize / 2, py);
        ctx.arc(px, py, pxSize / 2, 0, Math.PI * 2);
      }
      ctx.clip();
      ctx.drawImage(originalImg, 0, 0, imgW, imgH);
      ctx.restore();
    }
  }
}

/**
 * Renders translated text inside a region with full Arabic RTL shaping & connected ligatures,
 * contour-aligned width wrapping, visual centroid placement, and safe canvas clamping.
 */
export function renderRegionText(
  ctx: CanvasRenderingContext2D,
  imgW: number,
  imgH: number,
  region: TextRegion,
  seg?: BubbleSegmentationResult
): RenderedRegionMetrics | null {
  if (region.regionType === 'sfx' && (region.sfxMode === 'keep' || region.sfxMode === 'ignore')) {
    return null;
  }
  const rawText = (region.translatedText || '').trim();
  if (!rawText) return null;

  const fs = region.fontSettings;
  const isRtl = fs.direction === 'rtl';
  const text = !isRtl && fs.letterCase === 'uppercase' ? rawText.toUpperCase() : rawText;

  const useSegmentedBounds = Boolean(seg && seg.hasClosedBubble && seg.rowSpans.length > 0);
  const pxBox =
    useSegmentedBounds && seg
      ? seg.textSafeBoxPx || seg.safeBoxPx
      : normalizedBoxToImagePx(region.boundingBox, imgW, imgH);
  const boxW = Math.max(16, pxBox.width);
  const boxH = Math.max(16, pxBox.height);

  const scaleFactor = imgW / 1000;
  const baseFontSizePx = Math.max(10, fs.fontSize * scaleFactor);

  const fontStack = isRtl
    ? `"${fs.fontFamily}", "Cairo", "IBM Plex Sans Arabic", "Tajawal", sans-serif`
    : `"${fs.fontFamily}", "Comic Neue", "Architects Daughter", "Plus Jakarta Sans", sans-serif`;

  ctx.save();
  ctx.direction = isRtl ? 'rtl' : 'ltr';

  // Critical for Arabic ligatures and diacritics: never apply extra letter-spacing on RTL text
  if ('letterSpacing' in ctx) {
    (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = '0px';
  }

  const baseCenterPx =
    useSegmentedBounds && seg
      ? seg.centroidPx
      : (() => {
          const normCenter = computeRegionCenterNormalized(
            region.boundingBox,
            region.boundingPolygon
          );
          return {
            x: (normCenter.x / 1000) * imgW,
            y: (normCenter.y / 1000) * imgH,
          };
        })();

  const rawCenterX = baseCenterPx.x + (fs.offsetX / 1000) * imgW;
  const rawCenterY = baseCenterPx.y + (fs.offsetY / 1000) * imgH;
  const centerX = Math.max(12, Math.min(imgW - 12, rawCenterX));
  const centerY = Math.max(12, Math.min(imgH - 12, rawCenterY));

  const needsBackingPill =
    region.cleanMode === 'keep' || (region.regionType === 'sfx' && region.sfxMode === 'side');

  if (fs.direction === 'vertical') {
    const chars = Array.from(text);
    const stepSize = Math.min(
      baseFontSizePx * 1.15,
      Math.max(11, (boxH * 0.85) / Math.max(1, chars.length))
    );
    ctx.font = `${fs.fontWeight} ${Math.round(stepSize * 0.9)}px ${fontStack}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.translate(centerX, centerY);
    if (fs.rotation) ctx.rotate((fs.rotation * Math.PI) / 180);

    const startY = -((chars.length - 1) * stepSize) / 2;
    for (let i = 0; i < chars.length; i++) {
      if (fs.strokeWidth && fs.strokeColor) {
        ctx.lineWidth = fs.strokeWidth * scaleFactor;
        ctx.strokeStyle = fs.strokeColor;
        ctx.strokeText(chars[i], 0, startY + i * stepSize);
      }
      ctx.fillStyle = fs.color;
      ctx.fillText(chars[i], 0, startY + i * stepSize);
    }
    ctx.restore();
    return {
      textCenterPx: { x: centerX, y: centerY },
      textLines: [],
      overflowed: false,
    };
  }

  const measureFn = (str: string, fontSizePx: number): number => {
    ctx.direction = isRtl ? 'rtl' : 'ltr';
    ctx.font = `${fs.fontWeight} ${fontSizePx}px ${fontStack}`;
    return ctx.measureText(str).width;
  };

  const sfxSideShiftY = region.regionType === 'sfx' && region.sfxMode === 'side' ? boxH * 0.55 : 0;
  const effectiveCenterY = Math.max(12, Math.min(imgH - 12, centerY + sfxSideShiftY));

  // Query true inscribed contour width at each line's Y slice when segmented
  const getBandMaxWidthPx =
    useSegmentedBounds && seg
      ? (lineIdx: number, totalExpectedLines: number, lineHeightPx: number): number => {
          const totalH = totalExpectedLines * lineHeightPx;
          const lineY =
            effectiveCenterY - totalH / 2 + lineHeightPx / 2 + lineIdx * lineHeightPx;
          const span = getSafeWidthAtBandY(
            seg,
            lineY,
            lineHeightPx,
            Math.max(0.06, Math.min(0.2, fs.padding / 100))
          );
          return span.width;
        }
      : undefined;

  const fitted = fitTextInRegion(
    text,
    boxW,
    boxH,
    {
      fontSize: baseFontSizePx,
      lineHeight: fs.lineHeight,
      padding: fs.padding,
      autoFit: fs.autoFit,
      align: fs.align,
    },
    measureFn,
    getBandMaxWidthPx
  );

  ctx.font = `${fs.fontWeight} ${fitted.fontSize}px ${fontStack}`;
  ctx.direction = isRtl ? 'rtl' : 'ltr';
  ctx.textBaseline = 'middle';

  const anchorX = computeAlignedAnchorOffsetX(boxW, fs.align, fs.padding);
  if (fs.align === 'center') {
    ctx.textAlign = 'center';
  } else if (fs.align === 'right') {
    ctx.textAlign = 'right';
  } else {
    ctx.textAlign = 'left';
  }

  ctx.translate(centerX, effectiveCenterY);
  if (fs.rotation) {
    ctx.rotate((fs.rotation * Math.PI) / 180);
  }

  const totalTextHeight = fitted.lines.length * fitted.lineHeightPx;
  const maxLineWidth = fitted.lines.reduce((m, l) => Math.max(m, ctx.measureText(l).width), 0);

  if (needsBackingPill && fitted.lines.length > 0) {
    const padX = 10 * scaleFactor;
    const padY = 6 * scaleFactor;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
    ctx.strokeStyle = 'rgba(15, 23, 42, 0.24)';
    ctx.lineWidth = Math.max(1, scaleFactor);
    const rx = -maxLineWidth / 2 - padX;
    const ry = -totalTextHeight / 2 - padY;
    const rw = maxLineWidth + padX * 2;
    const rh = totalTextHeight + padY * 2;
    ctx.beginPath();
    ctx.roundRect(rx, ry, rw, rh, 6 * scaleFactor);
    ctx.fill();
    ctx.stroke();
  }

  const startY = -totalTextHeight / 2 + fitted.lineHeightPx / 2;
  const renderedLines: Array<{ y: number; width: number; height: number }> = [];

  for (let i = 0; i < fitted.lines.length; i++) {
    const line = fitted.lines[i];
    const lineY = startY + i * fitted.lineHeightPx;
    const absLineY = effectiveCenterY + lineY;

    let drawX = anchorX;
    const m = ctx.measureText(line);
    const lineWidthPx = m.width;

    if (fs.align === 'center') {
      // Shift slightly toward the scanline band center if contour is asymmetric and user hasn't manually offset X
      if (useSegmentedBounds && seg && fs.offsetX === 0 && !fs.rotation) {
        const span = getSafeWidthAtBandY(seg, absLineY, fitted.lineHeightPx, 0.04);
        const spanMidX = (span.leftX + span.rightX) / 2;
        const maxShift = Math.max(0, (span.width - lineWidthPx) * 0.45);
        const deltaToSpanMid = Math.max(-maxShift, Math.min(maxShift, spanMidX - centerX));
        drawX += deltaToSpanMid * 0.55;
      }
      drawX += computeOpticalCenterOffsetX(
        m.actualBoundingBoxLeft,
        m.actualBoundingBoxRight,
        fitted.fontSize
      );
    }

    // Clamp line horizontally inside canvas bounds when unrotated
    if (!fs.rotation && fs.align === 'center') {
      const halfW = lineWidthPx / 2 + 4;
      const minLocalX = halfW - centerX;
      const maxLocalX = imgW - halfW - centerX;
      if (minLocalX <= maxLocalX) {
        drawX = Math.max(minLocalX, Math.min(maxLocalX, drawX));
      }
    }

    if (
      (fs.strokeWidth && fs.strokeColor) ||
      (region.regionType === 'sfx' && region.sfxMode === 'artistic')
    ) {
      ctx.lineWidth = (fs.strokeWidth || 3.5) * scaleFactor;
      ctx.strokeStyle = fs.strokeColor || '#FFFFFF';
      ctx.lineJoin = 'round';
      ctx.strokeText(line, drawX, lineY);
    }
    ctx.fillStyle = fs.color || '#0F172A';
    ctx.fillText(line, drawX, lineY);

    renderedLines.push({
      y: absLineY,
      width: lineWidthPx,
      height: fitted.lineHeightPx,
    });
  }

  ctx.restore();
  return {
    textCenterPx: { x: centerX, y: effectiveCenterY },
    textLines: renderedLines,
    overflowed: fitted.overflowed,
  };
}

/**
 * Renders the complete non-destructive composite (Original + Cleaning + Manual Strokes + Translated Text)
 * onto an HTMLCanvasElement at the exact target dimensions and audits per-region CV & layout quality.
 */
export async function renderCompositePageToCanvas(
  canvas: HTMLCanvasElement,
  page: Page,
  options: {
    showOriginalOnly?: boolean;
    showText?: boolean;
    inpaintingEngine?: 'telea_biharmonic' | 'solid_interior' | 'manual_only';
    targetWidth?: number;
    targetHeight?: number;
    onRegionAudits?: (audits: Record<string, RegionQualityAudit>) => void;
  } = {}
): Promise<HTMLImageElement> {
  const img = await loadImage(page.originalImage);
  const w = options.targetWidth || img.naturalWidth || page.width || 900;
  const h = options.targetHeight || img.naturalHeight || page.height || 1200;

  if (page.rotation === 90 || page.rotation === 270) {
    canvas.width = h;
    canvas.height = w;
  } else {
    canvas.width = w;
    canvas.height = h;
  }

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return img;

  ctx.save();
  if (page.rotation) {
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate((page.rotation * Math.PI) / 180);
    ctx.drawImage(img, -w / 2, -h / 2, w, h);
  } else {
    ctx.drawImage(img, 0, 0, w, h);
  }
  ctx.restore();

  if (options.showOriginalOnly) {
    return img;
  }

  const engine = options.inpaintingEngine || 'telea_biharmonic';
  const cleanOutcomes = new Map<string, RegionCleanOutcome>();

  for (const region of page.regions) {
    if (
      region.regionType === 'sfx' &&
      region.sfxMode !== 'replace' &&
      region.sfxMode !== 'artistic'
    ) {
      continue;
    }
    const outcome = cleanAndSegmentRegionInPlace(
      ctx,
      canvas.width,
      canvas.height,
      region,
      engine
    );
    if (outcome) {
      cleanOutcomes.set(region.id, outcome);
    }
  }

  applyManualStrokes(ctx, img, canvas.width, canvas.height, page.manualStrokes || []);

  const audits: Record<string, RegionQualityAudit> = {};

  if (options.showText !== false) {
    for (const region of page.regions) {
      if (region.approvalStatus === 'rejected') continue;
      const outcome = cleanOutcomes.get(region.id);
      const metrics = renderRegionText(ctx, canvas.width, canvas.height, region, outcome?.seg);
      if (outcome && options.onRegionAudits) {
        audits[region.id] = auditCleanedAndRenderedRegion({
          beforeRoiData: outcome.beforeRoiData,
          afterRoiData: outcome.afterRoiData,
          seg: outcome.seg,
          imgW: canvas.width,
          imgH: canvas.height,
          textCenterPx: metrics?.textCenterPx,
          textLines: metrics?.textLines,
          overflowed: metrics?.overflowed,
        });
      }
    }
  }

  if (options.onRegionAudits) {
    options.onRegionAudits(audits);
  }

  return img;
}

const imageCache = new Map<string, HTMLImageElement>();
const MAX_IMAGE_CACHE = 24;

export function loadImage(src: string): Promise<HTMLImageElement> {
  if (!src) {
    return Promise.reject(new Error('Image source URL is empty'));
  }
  if (imageCache.has(src)) {
    const cached = imageCache.get(src)!;
    if (cached.complete && cached.naturalWidth > 0) {
      // Refresh LRU insertion order
      imageCache.delete(src);
      imageCache.set(src, cached);
      return Promise.resolve(cached);
    }
  }
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      if (imageCache.size >= MAX_IMAGE_CACHE) {
        const oldestKey = imageCache.keys().next().value;
        if (oldestKey !== undefined) imageCache.delete(oldestKey);
      }
      imageCache.set(src, img);
      resolve(img);
    };
    img.onerror = () => reject(new Error(`Failed to load image: ${src}`));
    img.src = src;
  });
}
