import JSZip from 'jszip';
import { jsPDF } from 'jspdf';
import type { AiSettings, Page, ReadingDirection } from '../types/domain';
import { loadImage, renderCompositePageToCanvas } from './inpainting';
import { orderPagesForExport } from './pageBatchUtils';

export type ExportFormat = 'png' | 'jpg' | 'webp' | 'pdf' | 'zip' | 'cbz';
export type ExportContentMode = 'translated' | 'original' | 'both';

export interface ExportOptions {
  format: ExportFormat;
  contentMode: ExportContentMode;
  includeEditableLayersJson: boolean;
  quality: number; // 0.7..1.0
  inpaintingEngine: AiSettings['inpaintingEngine'];
  readingDirection?: ReadingDirection;
  reverseSpreadPairsForRtl?: boolean;
  selectedPageNumbers?: number[];
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function canvasToBlob(canvas: HTMLCanvasElement, mime: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error('Canvas export produced empty blob'));
      },
      mime,
      quality
    );
  });
}

async function originalToBlob(page: Page, mime: string, quality: number): Promise<Blob> {
  const img = await loadImage(page.originalImage);
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth || page.width || 900;
  canvas.height = img.naturalHeight || page.height || 1200;
  const ctx = canvas.getContext('2d');
  ctx?.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvasToBlob(canvas, mime, quality);
}

export async function exportChapterPages(
  chapterTitle: string,
  pages: Page[],
  options: ExportOptions,
  onProgress?: (pct: number) => void
): Promise<void> {
  const safeBase = (chapterTitle || 'chapter').replace(/[^\w\u0600-\u06FF-]+/g, '_');

  const selectedSet =
    options.selectedPageNumbers && options.selectedPageNumbers.length > 0
      ? new Set(options.selectedPageNumbers)
      : null;

  const filtered = selectedSet
    ? pages.filter((p) => selectedSet.has(p.pageNumber))
    : pages;

  if (filtered.length === 0) {
    throw new Error('No pages matched the selected export range.');
  }

  const dir: ReadingDirection = options.readingDirection || 'ltr';
  const sorted = orderPagesForExport(filtered, dir, {
    reverseSpreadPairsForRtl: options.reverseSpreadPairsForRtl,
  });

  const imageExt = options.format === 'jpg' ? 'jpg' : options.format === 'webp' ? 'webp' : 'png';
  const imageMime =
    imageExt === 'jpg' ? 'image/jpeg' : imageExt === 'webp' ? 'image/webp' : 'image/png';

  // Single image direct download when exporting 1 page as PNG/JPG/WEBP without "both"
  if (
    sorted.length === 1 &&
    (options.format === 'png' || options.format === 'jpg' || options.format === 'webp') &&
    options.contentMode !== 'both' &&
    !options.includeEditableLayersJson
  ) {
    const page = sorted[0];
    const numStr = String(page.pageNumber).padStart(3, '0');
    onProgress?.(40);
    if (options.contentMode === 'original') {
      const blob = await originalToBlob(page, imageMime, options.quality);
      triggerDownload(blob, `${safeBase}_page_${numStr}_original.${imageExt}`);
    } else {
      const canvas = document.createElement('canvas');
      await renderCompositePageToCanvas(canvas, page, {
        inpaintingEngine: options.inpaintingEngine,
      });
      const blob = await canvasToBlob(canvas, imageMime, options.quality);
      triggerDownload(blob, `${safeBase}_page_${numStr}_translated.${imageExt}`);
    }
    onProgress?.(100);
    return;
  }

  if (options.format === 'pdf') {
    const firstCanvas = document.createElement('canvas');
    await renderCompositePageToCanvas(firstCanvas, sorted[0], {
      showOriginalOnly: options.contentMode === 'original',
      inpaintingEngine: options.inpaintingEngine,
    });

    const firstOrientation = firstCanvas.width > firstCanvas.height ? 'l' : 'p';
    const pdf = new jsPDF({
      orientation: firstOrientation,
      unit: 'px',
      format: [firstCanvas.width, firstCanvas.height],
      compress: false,
    });

    // Set PDF ViewerPreferences Direction (R2L for manga/Arabic RTL, L2R for LTR/vertical)
    const internalPdf = pdf.internal as unknown as {
      viewerPreferences?: (prefs: Record<string, unknown>) => void;
    };
    if (typeof internalPdf.viewerPreferences === 'function') {
      internalPdf.viewerPreferences({
        Direction: dir === 'rtl' ? 'R2L' : 'L2R',
      });
    }

    for (let i = 0; i < sorted.length; i++) {
      const page = sorted[i];
      const modes: Array<'translated' | 'original'> =
        options.contentMode === 'both'
          ? ['translated', 'original']
          : [options.contentMode];

      for (let m = 0; m < modes.length; m++) {
        const mode = modes[m];
        const canvas = i === 0 && m === 0 ? firstCanvas : document.createElement('canvas');
        if (!(i === 0 && m === 0)) {
          await renderCompositePageToCanvas(canvas, page, {
            showOriginalOnly: mode === 'original',
            inpaintingEngine: options.inpaintingEngine,
          });
          pdf.addPage([canvas.width, canvas.height], canvas.width > canvas.height ? 'l' : 'p');
        }
        const dataUrl = canvas.toDataURL('image/jpeg', Math.max(0.9, options.quality));
        pdf.addImage(dataUrl, 'JPEG', 0, 0, canvas.width, canvas.height);
      }
      onProgress?.(Math.round(((i + 1) / sorted.length) * 95));
    }

    const pdfBlob = pdf.output('blob');
    triggerDownload(pdfBlob, `${safeBase}.pdf`);
    onProgress?.(100);
    return;
  }

  // Package into ZIP or CBZ (also used when exporting multiple PNG/JPG/WEBP pages)
  const zip = new JSZip();
  const archiveExt = options.format === 'cbz' ? 'cbz' : 'zip';

  for (let i = 0; i < sorted.length; i++) {
    const page = sorted[i];
    const seqStr = String(i + 1).padStart(3, '0');
    const origNumStr = String(page.pageNumber).padStart(3, '0');

    if (options.contentMode === 'translated' || options.contentMode === 'both') {
      const canvas = document.createElement('canvas');
      await renderCompositePageToCanvas(canvas, page, {
        inpaintingEngine: options.inpaintingEngine,
      });
      const blob = await canvasToBlob(canvas, imageMime, options.quality);
      const folderPrefix = options.contentMode === 'both' ? 'translated/' : '';
      zip.file(`${folderPrefix}${seqStr}_p${origNumStr}_translated.${imageExt}`, blob);
    }

    if (options.contentMode === 'original' || options.contentMode === 'both') {
      const blob = await originalToBlob(page, imageMime, options.quality);
      const folderPrefix = options.contentMode === 'both' ? 'original/' : '';
      zip.file(`${folderPrefix}${seqStr}_p${origNumStr}_original.${imageExt}`, blob);
    }

    onProgress?.(Math.round(((i + 1) / sorted.length) * 85));
  }

  if (options.includeEditableLayersJson) {
    const editablePayload = {
      schemaVersion: '1.1',
      chapterTitle,
      readingDirection: dir,
      exportedAt: new Date().toISOString(),
      pages: sorted.map((p) => ({
        pageNumber: p.pageNumber,
        width: p.width,
        height: p.height,
        rotation: p.rotation,
        manualStrokes: p.manualStrokes,
        regions: p.regions,
      })),
    };
    zip.file('editable_layers.json', JSON.stringify(editablePayload, null, 2));
  }

  const zipBlob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  triggerDownload(zipBlob, `${safeBase}.${archiveExt}`);
  onProgress?.(100);
}
