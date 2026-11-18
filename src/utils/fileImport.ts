import JSZip from 'jszip';
import * as pdfjsLib from 'pdfjs-dist';
import { sortPageFilenames } from './bubbleLayout';
import { computeVerticalStripSlices } from './pageBatchUtils';

// Configure PDF.js worker via ESM bundle URL
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url
).toString();

export interface ImportedPageAsset {
  id: string;
  filename: string;
  dataUrl: string;
  width: number;
  height: number;
  contentHash: string;
  byteSize: number;
  rotation?: 0 | 90 | 180 | 270;
}

const ALLOWED_IMAGE_EXT = /\.(jpe?g|png|webp)$/i;

function getImageDimensions(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth || 900, height: img.naturalHeight || 1200 });
    img.onerror = () => resolve({ width: 900, height: 1200 });
    img.src = dataUrl;
  });
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function mimeFromFilename(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.webp')) return 'image/webp';
  return 'image/jpeg';
}

export async function computeBytesSha256Hex(buffer: ArrayBuffer | Uint8Array): Promise<string> {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (typeof crypto !== 'undefined' && crypto.subtle?.digest) {
    try {
      const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
      return Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    } catch {
      // Fallback for non-secure contexts
    }
  }
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < bytes.length; i++) {
    h1 ^= bytes[i];
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= bytes[i] + ((i & 0xff) << 1);
    h2 = Math.imul(h2, 0x85ebca6b);
  }
  return `${(h1 >>> 0).toString(16).padStart(8, '0')}${(h2 >>> 0)
    .toString(16)
    .padStart(8, '0')}-${bytes.length}`;
}

async function dataUrlToBytes(dataUrl: string): Promise<Uint8Array> {
  const commaIdx = dataUrl.indexOf(',');
  if (commaIdx === -1) return new Uint8Array(0);
  const b64 = dataUrl.slice(commaIdx + 1);
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    arr[i] = bin.charCodeAt(i);
  }
  return arr;
}

function nextFrameYield(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function makeAssetId(): string {
  return `asset-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Rotates an imported DataURL image by 90 degrees clockwise before upload,
 * returning the updated DataURL, dimensions, and refreshed contentHash.
 */
export async function rotateImageAsset90(asset: ImportedPageAsset): Promise<ImportedPageAsset> {
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = (e) => reject(e);
    img.src = asset.dataUrl;
  });
  const w = img.naturalWidth || asset.width || 900;
  const h = img.naturalHeight || asset.height || 1200;
  const canvas = document.createElement('canvas');
  canvas.width = h;
  canvas.height = w;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate(Math.PI / 2);
    ctx.drawImage(img, -w / 2, -h / 2, w, h);
  }
  const mime = asset.dataUrl.startsWith('data:image/jpeg')
    ? 'image/jpeg'
    : asset.dataUrl.startsWith('data:image/webp')
    ? 'image/webp'
    : 'image/png';
  const nextDataUrl = canvas.toDataURL(mime, 0.94);
  const bytes = await dataUrlToBytes(nextDataUrl);
  const contentHash = await computeBytesSha256Hex(bytes);
  return {
    ...asset,
    dataUrl: nextDataUrl,
    width: canvas.width,
    height: canvas.height,
    byteSize: bytes.byteLength,
    contentHash,
  };
}

/**
 * Converts a single replacement File into an ImportedPageAsset.
 */
export async function fileToImportedPageAsset(file: File): Promise<ImportedPageAsset> {
  const buf = await file.arrayBuffer();
  const contentHash = await computeBytesSha256Hex(buf);
  const dataUrl = await blobToDataUrl(file);
  const dims = await getImageDimensions(dataUrl);
  return {
    id: makeAssetId(),
    filename: file.name,
    dataUrl,
    width: dims.width,
    height: dims.height,
    contentHash,
    byteSize: buf.byteLength,
    rotation: 0,
  };
}

/**
 * Automatically slices overly tall webtoon strip images into balanced sequential panels
 * while keeping normal comic/manga pages intact.
 */
export async function sliceTallWebtoonAssetIfNeeded(
  asset: ImportedPageAsset
): Promise<ImportedPageAsset[]> {
  const slices = computeVerticalStripSlices(asset.width, asset.height);
  if (slices.length <= 1) return [asset];

  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = (e) => reject(e);
    img.src = asset.dataUrl;
  });

  const baseName = asset.filename.replace(/\.(jpe?g|png|webp)$/i, '');
  const mime = asset.dataUrl.startsWith('data:image/jpeg')
    ? 'image/jpeg'
    : asset.dataUrl.startsWith('data:image/webp')
    ? 'image/webp'
    : 'image/png';
  const ext = mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : 'png';

  const output: ImportedPageAsset[] = [];
  for (const slice of slices) {
    const canvas = document.createElement('canvas');
    canvas.width = asset.width;
    canvas.height = slice.height;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.drawImage(
        img,
        0,
        slice.y,
        asset.width,
        slice.height,
        0,
        0,
        asset.width,
        slice.height
      );
    }
    const sliceUrl = canvas.toDataURL(mime, 0.94);
    const bytes = await dataUrlToBytes(sliceUrl);
    const contentHash = await computeBytesSha256Hex(bytes);
    output.push({
      id: makeAssetId(),
      filename: `${baseName}_part${String(slice.index + 1).padStart(2, '0')}.${ext}`,
      dataUrl: sliceUrl,
      width: asset.width,
      height: slice.height,
      contentHash,
      byteSize: bytes.byteLength,
      rotation: 0,
    });
  }
  return output;
}

/**
 * Extracts and naturally sorts images from .zip, .cbz, .pdf, or raw image FileList / folders.
 * Supports unlimited open-ended page counts (from 1 page up to hundreds of graphic novel pages)
 * and automatically slices tall webtoon strips into balanced panels.
 */
export async function importFilesToPages(
  files: File[],
  onProgress?: (pct: number, statusText: string) => void,
  options?: { autoSplitTallWebtoon?: boolean }
): Promise<ImportedPageAsset[]> {
  const results: ImportedPageAsset[] = [];
  const rawImages: File[] = [];
  const shouldSplitTall = options?.autoSplitTallWebtoon !== false;

  const pushMaybeSliced = async (asset: ImportedPageAsset) => {
    if (!shouldSplitTall) {
      results.push(asset);
      return;
    }
    const parts = await sliceTallWebtoonAssetIfNeeded(asset).catch(() => [asset]);
    results.push(...parts);
  };

  for (const file of files) {
    const lower = file.name.toLowerCase();
    if (lower.endsWith('.zip') || lower.endsWith('.cbz')) {
      onProgress?.(5, `Extracting ${file.name}...`);
      const zip = await JSZip.loadAsync(file);
      const imageEntries: Array<{ name: string; entry: JSZip.JSZipObject }> = [];

      zip.forEach((relativePath, zipEntry) => {
        if (zipEntry.dir) return;
        if (relativePath.includes('__MACOSX') || relativePath.split('/').pop()?.startsWith('.')) return;
        if (ALLOWED_IMAGE_EXT.test(relativePath)) {
          imageEntries.push({ name: relativePath, entry: zipEntry });
        }
      });

      const sortedNames = sortPageFilenames(imageEntries.map((e) => e.name));
      const entryMap = new Map(imageEntries.map((e) => [e.name, e.entry]));

      for (let i = 0; i < sortedNames.length; i++) {
        const name = sortedNames[i];
        const entry = entryMap.get(name)!;
        const arrayBuf = await entry.async('arraybuffer');
        const contentHash = await computeBytesSha256Hex(arrayBuf);
        const typedBlob = new Blob([arrayBuf], { type: mimeFromFilename(name) });
        const dataUrl = await blobToDataUrl(typedBlob);
        const dims = await getImageDimensions(dataUrl);
        await pushMaybeSliced({
          id: makeAssetId(),
          filename: name.split('/').pop() || name,
          dataUrl,
          width: dims.width,
          height: dims.height,
          contentHash,
          byteSize: arrayBuf.byteLength,
          rotation: 0,
        });
        onProgress?.(10 + Math.round(((i + 1) / sortedNames.length) * 85), `${i + 1}/${sortedNames.length} · ${name}`);
        if (i % 6 === 5) await nextFrameYield();
      }
    } else if (lower.endsWith('.pdf')) {
      onProgress?.(5, `Reading PDF ${file.name}...`);
      const arrayBuffer = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
      const total = pdf.numPages;

      for (let pageNum = 1; pageNum <= total; pageNum++) {
        const pdfPage = await pdf.getPage(pageNum);
        const viewport = pdfPage.getViewport({ scale: 2.0 });
        const canvas = document.createElement('canvas');
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        const ctx = canvas.getContext('2d');
        if (ctx) {
          await pdfPage.render({ canvasContext: ctx, viewport, canvas } as Parameters<typeof pdfPage.render>[0]).promise;
          const dataUrl = canvas.toDataURL('image/png');
          const bytes = await dataUrlToBytes(dataUrl);
          const contentHash = await computeBytesSha256Hex(bytes);
          await pushMaybeSliced({
            id: makeAssetId(),
            filename: `${file.name.replace(/\.pdf$/i, '')}_page_${String(pageNum).padStart(3, '0')}.png`,
            dataUrl,
            width: canvas.width,
            height: canvas.height,
            contentHash,
            byteSize: bytes.byteLength,
            rotation: 0,
          });
        }
        onProgress?.(10 + Math.round((pageNum / total) * 85), `Page ${pageNum}/${total}`);
        if (pageNum % 3 === 0) await nextFrameYield();
      }
    } else if (ALLOWED_IMAGE_EXT.test(lower) || file.type.startsWith('image/')) {
      rawImages.push(file);
    }
  }

  if (rawImages.length > 0) {
    const sortedNames = sortPageFilenames(rawImages.map((f) => f.webkitRelativePath || f.name));
    const fileMap = new Map(rawImages.map((f) => [f.webkitRelativePath || f.name, f]));
    for (let i = 0; i < sortedNames.length; i++) {
      const key = sortedNames[i];
      const f = fileMap.get(key)!;
      const asset = await fileToImportedPageAsset(f);
      await pushMaybeSliced(asset);
      onProgress?.(15 + Math.round(((i + 1) / sortedNames.length) * 80), `${i + 1}/${sortedNames.length} · ${f.name}`);
      if (i % 6 === 5) await nextFrameYield();
    }
  }

  onProgress?.(100, 'Ready');
  return results;
}
