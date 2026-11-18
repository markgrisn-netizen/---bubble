import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { AiSettings, ManualStroke, Page, Point, TextRegion } from '../types/domain';
import { renderCompositePageToCanvas } from '../utils/inpainting';
import { boxToPolygon, polygonToBox } from '../utils/bubbleLayout';
import { computeNaturalFitSize } from '../utils/canvasViewport';
import {
  computeContainRect,
  displayClientToNormalized,
  displayDeltaToNormalized,
} from '../utils/coordinateTransform';

export type CanvasToolMode = 'select' | 'draw' | 'brush' | 'eraser' | 'pan';

interface BubbleCanvasProps {
  page: Page;
  selectedRegionId: string | null;
  toolMode: CanvasToolMode;
  brushSize: number;
  brushColor: string;
  zoom: number;
  resetSignal?: number;
  compareOriginal: boolean;
  showRegionOverlays?: boolean;
  inpaintingEngine: AiSettings['inpaintingEngine'];
  onSelectRegion: (regionId: string | null) => void;
  onUpdateRegionGeometry: (regionId: string, polygon: Point[]) => void;
  onCreateRegion: (box: { x: number; y: number; width: number; height: number }) => void;
  onAddManualStroke: (stroke: ManualStroke) => void;
}

export const BubbleCanvas: React.FC<BubbleCanvasProps> = ({
  page,
  selectedRegionId,
  toolMode,
  brushSize,
  brushColor,
  zoom,
  resetSignal = 0,
  compareOriginal,
  showRegionOverlays = false,
  inpaintingEngine,
  onSelectRegion,
  onUpdateRegionGeometry,
  onCreateRegion,
  onAddManualStroke,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [canvasDims, setCanvasDims] = useState({ w: page.width || 900, h: page.height || 1200 });
  const [containerSize, setContainerSize] = useState({ w: 860, h: 680 });
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [compareSplit, setCompareSplit] = useState(50);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const updateSize = () => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        setContainerSize({
          w: Math.round(rect.width),
          h: Math.round(rect.height),
        });
      }
    };
    updateSize();
    const ro = new ResizeObserver(updateSize);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    setPan({ x: 0, y: 0 });
  }, [page.id, resetSignal]);

  // Interaction state for dragging boxes, handles, drawing, or brushing
  const [dragState, setDragState] = useState<{
    kind: 'move_region' | 'move_vertex' | 'draw_box' | 'brush' | 'pan';
    regionId?: string;
    vertexIdx?: number;
    startClientX: number;
    startClientY: number;
    startPanX: number;
    startPanY: number;
    initialPoly?: Point[];
    draftBox?: { x: number; y: number; width: number; height: number };
    draftPoints?: Point[];
  } | null>(null);

  const [livePolyOverride, setLivePolyOverride] = useState<{
    regionId: string;
    polygon: Point[];
  } | null>(null);

  // Re-render composite page onto Canvas whenever page state, regions, or compare toggle changes
  useEffect(() => {
    let cancelled = false;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const effectivePage: Page = livePolyOverride
      ? {
          ...page,
          regions: page.regions.map((r) =>
            r.id === livePolyOverride.regionId
              ? {
                  ...r,
                  boundingPolygon: livePolyOverride.polygon,
                  boundingBox: polygonToBox(livePolyOverride.polygon),
                }
              : r
          ),
        }
      : page;

    void renderCompositePageToCanvas(canvas, effectivePage, {
      showOriginalOnly: false,
      showText: true,
      inpaintingEngine,
    }).then(() => {
      if (!cancelled && canvas) {
        setCanvasDims({ w: canvas.width, h: canvas.height });
      }
    });

    return () => {
      cancelled = true;
    };
  }, [page, inpaintingEngine, livePolyOverride]);

  const clientToNormalized = (clientX: number, clientY: number): Point => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return displayClientToNormalized(clientX, clientY, rect, canvasDims.w, canvasDims.h);
  };

  const handlePointerDownCanvas = (e: React.PointerEvent<HTMLDivElement>) => {
    if (toolMode === 'pan' || e.button === 1) {
      setDragState({
        kind: 'pan',
        startClientX: e.clientX,
        startClientY: e.clientY,
        startPanX: pan.x,
        startPanY: pan.y,
      });
      return;
    }

    const pt = clientToNormalized(e.clientX, e.clientY);

    if (toolMode === 'draw') {
      setDragState({
        kind: 'draw_box',
        startClientX: e.clientX,
        startClientY: e.clientY,
        startPanX: pan.x,
        startPanY: pan.y,
        draftPoints: [pt],
        draftBox: { x: pt.x, y: pt.y, width: 10, height: 10 },
      });
      return;
    }

    if (toolMode === 'brush' || toolMode === 'eraser') {
      setDragState({
        kind: 'brush',
        startClientX: e.clientX,
        startClientY: e.clientY,
        startPanX: pan.x,
        startPanY: pan.y,
        draftPoints: [pt],
      });
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragState) return;

    if (dragState.kind === 'pan') {
      setPan({
        x: dragState.startPanX + (e.clientX - dragState.startClientX),
        y: dragState.startPanY + (e.clientY - dragState.startClientY),
      });
      return;
    }

    const pt = clientToNormalized(e.clientX, e.clientY);

    if (dragState.kind === 'draw_box' && dragState.draftPoints?.[0]) {
      const origin = dragState.draftPoints[0];
      const x = Math.min(origin.x, pt.x);
      const y = Math.min(origin.y, pt.y);
      const width = Math.max(12, Math.abs(pt.x - origin.x));
      const height = Math.max(12, Math.abs(pt.y - origin.y));
      setDragState((prev) => (prev ? { ...prev, draftBox: { x, y, width, height } } : null));
      return;
    }

    if (dragState.kind === 'brush') {
      setDragState((prev) =>
        prev ? { ...prev, draftPoints: [...(prev.draftPoints || []), pt] } : null
      );
      return;
    }

    if (dragState.kind === 'move_region' && dragState.regionId && dragState.initialPoly) {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const { dx: dxNorm, dy: dyNorm } = displayDeltaToNormalized(
        e.clientX - dragState.startClientX,
        e.clientY - dragState.startClientY,
        rect,
        canvasDims.w,
        canvasDims.h
      );
      const moved = dragState.initialPoly.map((p) => ({
        x: Math.max(0, Math.min(1000, Math.round(p.x + dxNorm))),
        y: Math.max(0, Math.min(1000, Math.round(p.y + dyNorm))),
      }));
      setLivePolyOverride({ regionId: dragState.regionId, polygon: moved });
      return;
    }

    if (
      dragState.kind === 'move_vertex' &&
      dragState.regionId &&
      typeof dragState.vertexIdx === 'number' &&
      dragState.initialPoly
    ) {
      const updated = dragState.initialPoly.map((p, idx) =>
        idx === dragState.vertexIdx ? pt : p
      );
      setLivePolyOverride({ regionId: dragState.regionId, polygon: updated });
    }
  };

  const handlePointerUp = () => {
    if (!dragState) return;

    if (dragState.kind === 'draw_box' && dragState.draftBox) {
      if (dragState.draftBox.width >= 25 && dragState.draftBox.height >= 25) {
        onCreateRegion(dragState.draftBox);
      }
    } else if (dragState.kind === 'brush' && dragState.draftPoints?.length) {
      onAddManualStroke({
        id: `stroke-${Date.now()}`,
        tool: toolMode === 'eraser' ? 'eraser' : 'brush',
        size: brushSize,
        color: brushColor,
        points: dragState.draftPoints,
      });
    } else if (
      (dragState.kind === 'move_region' || dragState.kind === 'move_vertex') &&
      livePolyOverride
    ) {
      onUpdateRegionGeometry(livePolyOverride.regionId, livePolyOverride.polygon);
    }

    setDragState(null);
    setLivePolyOverride(null);
  };

  const getEffectivePoly = (r: TextRegion): Point[] => {
    if (livePolyOverride && livePolyOverride.regionId === r.id) {
      return livePolyOverride.polygon;
    }
    return r.boundingPolygon.length >= 3 ? r.boundingPolygon : boxToPolygon(r.boundingBox);
  };

  const cursorClass =
    toolMode === 'pan'
      ? 'cursor-grab active:cursor-grabbing'
      : toolMode === 'draw' || toolMode === 'brush' || toolMode === 'eraser'
      ? 'cursor-crosshair'
      : 'cursor-default';

  const isCompactViewport = containerSize.w < 640;
  const fit = computeNaturalFitSize({
    naturalWidth: canvasDims.w,
    naturalHeight: canvasDims.h,
    containerWidth: containerSize.w,
    containerHeight: containerSize.h,
    paddingX: isCompactViewport ? 12 : 24,
    paddingY: isCompactViewport ? 12 : 24,
    zoom,
    mode: 'contain',
  });
  const contain = computeContainRect(canvasDims.w, canvasDims.h, fit.displayWidth, fit.displayHeight);

  return (
    <div
      ref={containerRef}
      data-testid="studio-canvas-viewport"
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerUp}
      className={`relative flex-1 min-w-0 min-h-[56vh] lg:min-h-0 overflow-auto bg-slate-100 dark:bg-[#0B0E14] flex p-3 sm:p-6 select-none ${cursorClass}`}
    >
      {/* Compare Slider Control when Compare mode is active */}
      {compareOriginal && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-30 flex items-center gap-3 px-4 py-2 rounded-lg bg-slate-900/90 text-white text-xs shadow-lg">
          <span>Original</span>
          <input
            type="range"
            min="0"
            max="100"
            value={compareSplit}
            onChange={(e) => setCompareSplit(Number(e.target.value))}
            aria-label="Before and after comparison split"
            className="w-36"
          />
          <span>Translated</span>
        </div>
      )}

      <div
        dir="ltr"
        data-testid="studio-canvas-stage"
        onPointerDown={handlePointerDownCanvas}
        data-natural-width={canvasDims.w}
        data-natural-height={canvasDims.h}
        data-display-width={fit.displayWidth}
        data-display-height={fit.displayHeight}
        style={{
          transform: pan.x !== 0 || pan.y !== 0 ? `translate(${pan.x}px, ${pan.y}px)` : undefined,
          width: `${fit.displayWidth}px`,
          height: `${fit.displayHeight}px`,
        }}
        className="relative m-auto shadow-md ring-1 ring-slate-200/80 dark:ring-slate-800 bg-white shrink-0"
      >
        {/* Main Non-Destructive Composite Canvas */}
        <canvas
          ref={canvasRef}
          data-testid="studio-canvas"
          className="w-full h-full block object-contain"
        />

        {/* Before / After Original Image Split Overlay (aligned to contained bitmap) */}
        {compareOriginal && (
          <div
            style={{
              left: `${contain.offsetX}px`,
              top: `${contain.offsetY}px`,
              width: `${contain.contentWidth}px`,
              height: `${contain.contentHeight}px`,
              clipPath: `inset(0 ${100 - compareSplit}% 0 0)`,
            }}
            className="absolute pointer-events-none"
          >
            <img
              src={page.originalImage}
              alt="Original comparison"
              className="w-full h-full object-fill"
            />
            <div
              style={{ left: `${compareSplit}%` }}
              className="absolute top-0 bottom-0 w-1 bg-[#FFE01B] shadow-[0_0_0_1px_#111111]"
            />
          </div>
        )}

        {/* Interactive SVG Overlay pinned to exact contained bitmap rectangle */}
        <svg
          viewBox="0 0 1000 1000"
          preserveAspectRatio="none"
          style={{
            left: `${contain.offsetX}px`,
            top: `${contain.offsetY}px`,
            width: `${contain.contentWidth}px`,
            height: `${contain.contentHeight}px`,
          }}
          className="absolute"
        >
          {page.regions.map((region) => {
            const poly = getEffectivePoly(region);
            const isSelected = region.id === selectedRegionId;
            const ptsStr = poly.map((p) => `${p.x},${p.y}`).join(' ');
            const strokeColor = isSelected
              ? '#0F172A'
              : region.regionType === 'sfx'
              ? '#E11D48'
              : region.regionType === 'narration'
              ? '#D97706'
              : '#64748B';

            return (
              <g key={region.id} data-region-id={region.id}>
                <polygon
                  points={ptsStr}
                  fill={
                    showRegionOverlays
                      ? isSelected
                        ? 'rgba(15, 23, 42, 0.08)'
                        : 'rgba(100, 116, 139, 0.04)'
                      : 'transparent'
                  }
                  stroke={showRegionOverlays ? strokeColor : 'none'}
                  strokeWidth={showRegionOverlays ? (isSelected ? 2.5 : 1.5) : 0}
                  strokeDasharray={showRegionOverlays && !isSelected ? '6 4' : undefined}
                  className={
                    toolMode === 'select'
                      ? showRegionOverlays
                        ? 'cursor-move'
                        : 'cursor-pointer'
                      : 'pointer-events-none'
                  }
                  onPointerDown={(e) => {
                    if (toolMode !== 'select') return;
                    e.stopPropagation();
                    onSelectRegion(region.id);
                    setDragState({
                      kind: 'move_region',
                      regionId: region.id,
                      startClientX: e.clientX,
                      startClientY: e.clientY,
                      startPanX: pan.x,
                      startPanY: pan.y,
                      initialPoly: poly,
                    });
                  }}
                />
                {/* Reading order index badge — only visible when guides are explicitly toggled on */}
                {showRegionOverlays && (
                  <>
                    <rect
                      x={poly[0]?.x ?? region.boundingBox.x}
                      y={Math.max(0, (poly[0]?.y ?? region.boundingBox.y) - 22)}
                      width="24"
                      height="20"
                      rx="4"
                      fill={strokeColor}
                      className="pointer-events-none"
                    />
                    <text
                      x={(poly[0]?.x ?? region.boundingBox.x) + 12}
                      y={Math.max(0, (poly[0]?.y ?? region.boundingBox.y) - 8)}
                      textAnchor="middle"
                      fill="#FFFFFF"
                      fontSize="13"
                      fontWeight="700"
                      className="pointer-events-none select-none"
                    >
                      {region.readingOrder}
                    </text>
                  </>
                )}

                {/* Draggable Polygon Control Points — only visible when guides are explicitly toggled on */}
                {showRegionOverlays &&
                  isSelected &&
                  toolMode === 'select' &&
                  poly.map((pt, idx) => (
                    <circle
                      key={idx}
                      cx={pt.x}
                      cy={pt.y}
                      r="7"
                      fill="#FFFFFF"
                      stroke="#0F172A"
                      strokeWidth="2.5"
                      className="cursor-nwse-resize"
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        setDragState({
                          kind: 'move_vertex',
                          regionId: region.id,
                          vertexIdx: idx,
                          startClientX: e.clientX,
                          startClientY: e.clientY,
                          startPanX: pan.x,
                          startPanY: pan.y,
                          initialPoly: poly,
                        });
                      }}
                    />
                  ))}
              </g>
            );
          })}

          {/* Draft Box while drawing a manual bubble */}
          {dragState?.kind === 'draw_box' && dragState.draftBox && (
            <rect
              x={dragState.draftBox.x}
              y={dragState.draftBox.y}
              width={dragState.draftBox.width}
              height={dragState.draftBox.height}
              fill="rgba(15, 23, 42, 0.1)"
              stroke="#334155"
              strokeWidth="2.5"
              strokeDasharray="6 3"
            />
          )}

          {/* Live brush preview */}
          {dragState?.kind === 'brush' && dragState.draftPoints && (
            <polyline
              points={dragState.draftPoints.map((p) => `${p.x},${p.y}`).join(' ')}
              fill="none"
              stroke={toolMode === 'eraser' ? '#E11D48' : brushColor}
              strokeWidth={brushSize}
              strokeLinecap="round"
              strokeLinejoin="round"
              opacity={0.75}
            />
          )}
        </svg>
      </div>
    </div>
  );
};
