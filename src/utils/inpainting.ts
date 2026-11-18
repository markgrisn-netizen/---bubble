import type { ManualStroke, Page, Point, TextRegion } from '../types/domain';
import { fitTextInRegion } from './bubbleLayout';
import {
  computeAlignedAnchorOffsetX,
  computeOpticalCenterOffsetX,
  computeRegionCenterNormalized,
  normalizedBoxToImagePx,
} from './coordinateTransform';

function pointInPolygon(x: number, y: number, poly: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x;
    const yi = poly[i].y;
    const xj = poly[j].x;
    const yj = poly[j].y;
    const intersect =
      yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-6) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

export interface RegionBackgroundStats {
  r: number;
  g: number;
  b: number;
  luma: number;
  isUniform: boolean;
  isDark: boolean;
}

/**
 * Estimates dominant interior background color (RGB) along an inset region inside a bubble
 * or narration caption box so dark/noir bubbles (dark fill + white text), colored Western
 * caption boxes (yellow/blue/tan), and white balloons are cleaned cleanly without touching borders.
 */
export function sampleInteriorBackground(
  data: Uint8ClampedArray,
  imgW: number,
  imgH: number,
  pxPoly: Point[],
  minX: number,
  minY: number,
  maxX: number,
  maxY: number
): RegionBackgroundStats {
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;

  const insetPoly = pxPoly.map((p) => ({
    x: cx + (p.x - cx) * 0.84,
    y: cy + (p.y - cy) * 0.84,
  }));

  const bins = new Map<string, { count: number; rSum: number; gSum: number; bSum: number }>();
  const stepX = Math.max(1, Math.floor((maxX - minX) / 48));
  const stepY = Math.max(1, Math.floor((maxY - minY) / 48));
  let totalSamples = 0;

  for (let y = minY; y <= maxY; y += stepY) {
    for (let x = minX; x <= maxX; x += stepX) {
      if (!pointInPolygon(x, y, insetPoly)) continue;
      const idx = (y * imgW + x) * 4;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      const key = `${r >> 4}-${g >> 4}-${b >> 4}`;
      const existing = bins.get(key);
      if (existing) {
        existing.count++;
        existing.rSum += r;
        existing.gSum += g;
        existing.bSum += b;
      } else {
        bins.set(key, { count: 1, rSum: r, gSum: g, bSum: b });
      }
      totalSamples++;
    }
  }

  let best = { count: 0, rSum: 255, gSum: 255, bSum: 255 };
  for (const bin of bins.values()) {
    if (bin.count > best.count) best = bin;
  }

  if (best.count === 0) {
    return { r: 255, g: 255, b: 255, luma: 255, isUniform: true, isDark: false };
  }

  const r = Math.round(best.rSum / best.count);
  const g = Math.round(best.gSum / best.count);
  const b = Math.round(best.bSum / best.count);
  const luma = 0.299 * r + 0.587 * g + 0.114 * b;
  const isUniform = totalSamples > 0 && best.count / totalSamples >= 0.42;
  return { r, g, b, luma, isUniform, isDark: luma < 95 };
}

/**
 * Generates an automatic pixel-exact mask of text strokes inside a region polygon
 * and inpaints ONLY those masked text pixels via multi-pass neighbor diffusion,
 * preserving bubble outlines, narration frames, colored art, and dark comic backgrounds.
 */
export function cleanRegionInPlace(
  ctx: CanvasRenderingContext2D,
  imgW: number,
  imgH: number,
  region: TextRegion,
  engine: 'telea_biharmonic' | 'solid_interior' | 'manual_only' = 'telea_biharmonic'
): void {
  if (region.cleanMode !== 'auto' || engine === 'manual_only') return;

  const poly =
    region.boundingPolygon.length >= 3
      ? region.boundingPolygon
      : [
          { x: region.boundingBox.x, y: region.boundingBox.y },
          { x: region.boundingBox.x + region.boundingBox.width, y: region.boundingBox.y },
          {
            x: region.boundingBox.x + region.boundingBox.width,
            y: region.boundingBox.y + region.boundingBox.height,
          },
          { x: region.boundingBox.x, y: region.boundingBox.y + region.boundingBox.height },
        ];

  const pxPoly = poly.map((p) => ({
    x: (p.x / 1000) * imgW,
    y: (p.y / 1000) * imgH,
  }));

  const minX = Math.max(0, Math.floor(Math.min(...pxPoly.map((p) => p.x))));
  const minY = Math.max(0, Math.floor(Math.min(...pxPoly.map((p) => p.y))));
  const maxX = Math.min(imgW - 1, Math.ceil(Math.max(...pxPoly.map((p) => p.x))));
  const maxY = Math.min(imgH - 1, Math.ceil(Math.max(...pxPoly.map((p) => p.y))));

  const roiW = maxX - minX + 1;
  const roiH = maxY - minY + 1;
  if (roiW <= 4 || roiH <= 4) return;

  const imgData = ctx.getImageData(minX, minY, roiW, roiH);
  const data = imgData.data;

  const localPoly = pxPoly.map((p) => ({ x: p.x - minX, y: p.y - minY }));
  const lcx = roiW / 2;
  const lcy = roiH / 2;
  const useEllipseMask = region.regionType === 'dialogue' && localPoly.length === 4;
  // Narration boxes in Western comics have crisp dark borders — inset slightly inside to keep borders intact
  const safeFactorX = region.regionType === 'narration' ? 0.98 : 0.96;
  const safeFactorY = region.regionType === 'narration' ? 0.96 : 0.96;
  const safePoly = localPoly.map((p) => ({
    x: lcx + (p.x - lcx) * safeFactorX,
    y: lcy + (p.y - lcy) * safeFactorY,
  }));

  const isInsideSafeArea = (x: number, y: number): boolean => {
    if (useEllipseMask) {
      const rx = Math.max(4, roiW * 0.485);
      const ry = Math.max(4, roiH * 0.485);
      const nx = Math.abs(x - lcx) / rx;
      const ny = Math.abs(y - lcy) / ry;
      return Math.pow(nx, 2.8) + Math.pow(ny, 2.8) <= 1.0;
    }
    return pointInPolygon(x, y, safePoly);
  };

  const bg = sampleInteriorBackground(
    data,
    roiW,
    roiH,
    localPoly,
    0,
    0,
    roiW - 1,
    roiH - 1
  );

  // Build binary mask (1 = text stroke to remove, 0 = background/border/artwork to keep)
  const mask = new Uint8Array(roiW * roiH);
  const rgbThreshold = bg.isUniform ? (bg.isDark ? 34 : 38) : 50;
  const lumaThreshold = bg.isUniform ? 34 : 46;

  for (let y = 0; y < roiH; y++) {
    for (let x = 0; x < roiW; x++) {
      if (!isInsideSafeArea(x, y)) continue;
      const idx = (y * roiW + x) * 4;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      const dr = Math.abs(r - bg.r);
      const dg = Math.abs(g - bg.g);
      const db = Math.abs(b - bg.b);
      const rgbDiff = (dr + dg + db) / 3;
      const pLuma = 0.299 * r + 0.587 * g + 0.114 * b;
      const lumaDiff = Math.abs(pLuma - bg.luma);

      if (rgbDiff > rgbThreshold || lumaDiff > lumaThreshold) {
        mask[y * roiW + x] = 1;
      }
    }
  }

  // Dilate text mask by 2 pixels to cleanly remove anti-aliased glyph edges & drop-shadows
  const dilated = new Uint8Array(roiW * roiH);
  const dilateRadius = 2;
  for (let y = 0; y < roiH; y++) {
    for (let x = 0; x < roiW; x++) {
      if (mask[y * roiW + x] === 1) {
        for (let dy = -dilateRadius; dy <= dilateRadius; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= roiH) continue;
          for (let dx = -dilateRadius; dx <= dilateRadius; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= roiW) continue;
            if (isInsideSafeArea(nx, ny)) {
              dilated[ny * roiW + nx] = 1;
            }
          }
        }
      }
    }
  }

  if (engine === 'solid_interior' && bg.isUniform) {
    for (let y = 0; y < roiH; y++) {
      for (let x = 0; x < roiW; x++) {
        if (dilated[y * roiW + x] === 1) {
          const idx = (y * roiW + x) * 4;
          data[idx] = bg.r;
          data[idx + 1] = bg.g;
          data[idx + 2] = bg.b;
          data[idx + 3] = 255;
        }
      }
    }
    ctx.putImageData(imgData, minX, minY);
    return;
  }

  // Multi-pass boundary-inward Telea-style harmonic diffusion inpainting
  const known = new Uint8Array(roiW * roiH);
  for (let i = 0; i < known.length; i++) {
    known[i] = dilated[i] === 0 ? 1 : 0;
  }

  const maxPasses = Math.min(34, Math.max(12, Math.ceil(Math.min(roiW, roiH) * 0.28)));
  const neighbors = [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ];

  for (let pass = 0; pass < maxPasses; pass++) {
    const newlyFilled: Array<{ x: number; y: number; r: number; g: number; b: number }> = [];
    for (let y = 1; y < roiH - 1; y++) {
      for (let x = 1; x < roiW - 1; x++) {
        const pos = y * roiW + x;
        if (known[pos] === 1) continue;

        let rSum = 0;
        let gSum = 0;
        let bSum = 0;
        let wSum = 0;

        for (let k = 0; k < neighbors.length; k++) {
          const nx = x + neighbors[k][0];
          const ny = y + neighbors[k][1];
          const npos = ny * roiW + nx;
          if (known[npos] === 1) {
            const weight = k < 4 ? 1.0 : 0.707;
            const idx = npos * 4;
            rSum += data[idx] * weight;
            gSum += data[idx + 1] * weight;
            bSum += data[idx + 2] * weight;
            wSum += weight;
          }
        }

        if (wSum > 0) {
          newlyFilled.push({
            x,
            y,
            r: Math.round(rSum / wSum),
            g: Math.round(gSum / wSum),
            b: Math.round(bSum / wSum),
          });
        }
      }
    }

    if (newlyFilled.length === 0) break;
    for (const item of newlyFilled) {
      const pos = item.y * roiW + item.x;
      const idx = pos * 4;
      data[idx] = item.r;
      data[idx + 1] = item.g;
      data[idx + 2] = item.b;
      data[idx + 3] = 255;
      known[pos] = 1;
    }
  }

  for (let i = 0; i < known.length; i++) {
    if (known[i] === 0) {
      const idx = i * 4;
      data[idx] = bg.r;
      data[idx + 1] = bg.g;
      data[idx + 2] = bg.b;
      data[idx + 3] = 255;
    }
  }

  ctx.putImageData(imgData, minX, minY);
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
 * authentic English Comic Lettering (Comic Neue / Bangers / Architects Daughter),
 * balanced line-wrapping inside oval balloons, and SFX/caption styling.
 */
export function renderRegionText(
  ctx: CanvasRenderingContext2D,
  imgW: number,
  imgH: number,
  region: TextRegion
): void {
  if (region.regionType === 'sfx' && (region.sfxMode === 'keep' || region.sfxMode === 'ignore')) {
    return;
  }
  const rawText = (region.translatedText || '').trim();
  if (!rawText) return;

  const fs = region.fontSettings;
  const isRtl = fs.direction === 'rtl';
  const text = !isRtl && fs.letterCase === 'uppercase' ? rawText.toUpperCase() : rawText;

  const pxBox = normalizedBoxToImagePx(region.boundingBox, imgW, imgH);
  const boxW = pxBox.width;
  const boxH = pxBox.height;

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

  const normCenter = computeRegionCenterNormalized(region.boundingBox, region.boundingPolygon);
  const centerX = (normCenter.x / 1000) * imgW + (fs.offsetX / 1000) * imgW;
  const centerY = (normCenter.y / 1000) * imgH + (fs.offsetY / 1000) * imgH;

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
    return;
  }

  const measureFn = (str: string, fontSizePx: number): number => {
    ctx.direction = isRtl ? 'rtl' : 'ltr';
    ctx.font = `${fs.fontWeight} ${fontSizePx}px ${fontStack}`;
    return ctx.measureText(str).width;
  };

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
    measureFn
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

  const sfxSideShiftY = region.regionType === 'sfx' && region.sfxMode === 'side' ? boxH * 0.55 : 0;

  ctx.translate(centerX, centerY + sfxSideShiftY);
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

  for (let i = 0; i < fitted.lines.length; i++) {
    const line = fitted.lines[i];
    const lineY = startY + i * fitted.lineHeightPx;
    let drawX = anchorX;
    if (fs.align === 'center') {
      const m = ctx.measureText(line);
      drawX += computeOpticalCenterOffsetX(
        m.actualBoundingBoxLeft,
        m.actualBoundingBoxRight,
        fitted.fontSize
      );
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
  }

  ctx.restore();
}

/**
 * Renders the complete non-destructive composite (Original + Cleaning + Manual Strokes + Translated Text)
 * onto an HTMLCanvasElement at the exact target dimensions.
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

  for (const region of page.regions) {
    if (
      region.regionType === 'sfx' &&
      region.sfxMode !== 'replace' &&
      region.sfxMode !== 'artistic'
    ) {
      continue;
    }
    cleanRegionInPlace(
      ctx,
      canvas.width,
      canvas.height,
      region,
      options.inpaintingEngine || 'telea_biharmonic'
    );
  }

  applyManualStrokes(ctx, img, canvas.width, canvas.height, page.manualStrokes || []);

  if (options.showText !== false) {
    for (const region of page.regions) {
      if (region.approvalStatus === 'rejected') continue;
      renderRegionText(ctx, canvas.width, canvas.height, region);
    }
  }

  return img;
}

const imageCache = new Map<string, HTMLImageElement>();
const MAX_IMAGE_CACHE = 24;

export function loadImage(src: string): Promise<HTMLImageElement> {
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
    img.onerror = (err) => reject(err);
    img.src = src;
  });
}
