"use client";

import { useRef, useState } from "react";
import { ImageOff, RotateCw } from "lucide-react";
import type { Detection, DetectionCreate } from "@/lib/types";

interface Props {
  imageSrc: string;
  detections: Detection[];
  threshold: number;         // boxes below this (unconfirmed) show amber
  addMode: boolean;          // true = drag to draw; false = click to select
  selectedId: number | null;
  onSelectDetection: (id: number | null) => void;
  onAddDetection: (payload: DetectionCreate) => void;
  onDeleteDetection?: (detectionId: number) => void; // kept for API compat
  /** Shaded areas this image shares with other images (normalized polygons). */
  overlapRegions?: OverlapRegion[];
  /** Boxes to ring in fuchsia (e.g. a duplicate and the box it duplicates). */
  highlightIds?: number[];
  hideLegend?: boolean;
  /**
   * The backend already found this file unreadable ("Could not process").
   * Only then does the placeholder say the file is damaged; otherwise a failed
   * load is more likely a network hiccup (slow tunnel, server restart).
   */
  knownUnreadable?: boolean;
}

export interface OverlapRegion {
  key: string | number;
  points: [number, number][];
  label: string;
  active?: boolean;          // stronger shading for the region being compared
}

const COLOR_OVERLAP   = "#8b5cf6"; // violet-500
const COLOR_HIGHLIGHT = "#d946ef"; // fuchsia-500

/** Polygon centroid clamped inside the image, for placing the region label. */
function labelPos(points: [number, number][]): { x: number; y: number } {
  const clamp = (v: number) => Math.min(0.85, Math.max(0.02, v));
  const inside = points.map(([x, y]) => [Math.min(1, Math.max(0, x)), Math.min(1, Math.max(0, y))]);
  const x = inside.reduce((a, p) => a + p[0], 0) / inside.length;
  const y = inside.reduce((a, p) => a + p[1], 0) / inside.length;
  return { x: clamp(x), y: clamp(y) };
}

// Box colour by state
const COLOR_ACCEPTED = "#22c55e"; // green-500
const COLOR_REVIEW   = "#f59e0b"; // amber-400
const COLOR_MANUAL   = "#3b82f6"; // blue-500
const COLOR_DUP      = "#94a3b8"; // slate-400 — counted in an overlapping image
const MIN_DRAG_PX    = 5;

function boxColor(det: Detection, threshold: number): string {
  if (det.is_duplicate) return COLOR_DUP;
  if (det.source === "manual") return COLOR_MANUAL;
  if (det.is_confirmed) return COLOR_ACCEPTED;
  if (det.confidence !== null && det.confidence >= threshold) return COLOR_ACCEPTED;
  return COLOR_REVIEW;
}

interface DragBox {
  x1: number; y1: number; // normalized (0-1)
  x2: number; y2: number;
}

export default function ImageAnnotator({
  imageSrc,
  detections,
  threshold,
  addMode,
  selectedId,
  onSelectDetection,
  onAddDetection,
  overlapRegions = [],
  highlightIds = [],
  hideLegend = false,
  knownUnreadable = false,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const dragStart    = useRef<{ x: number; y: number } | null>(null);
  const [dragBox, setDragBox] = useState<DragBox | null>(null);
  // Retry attempts for the current image. Stored with the src it belongs to,
  // so switching to another image starts again at 0 by itself.
  const [retry, setRetry] = useState({ src: imageSrc, n: 0 });
  const attempt = retry.src === imageSrc ? retry.n : 0;
  // A retry adds ?retry=N so the browser makes a fresh request instead of reusing the failed one
  const displaySrc = attempt > 0
    ? `${imageSrc}${imageSrc.includes("?") ? "&" : "?"}retry=${attempt}`
    : imageSrc;
  // The src the browser failed to display (network problem or unreadable file)
  const [failedSrc, setFailedSrc] = useState<string | null>(null);

  // Convert a mouse event to 0-1 normalized coords relative to the container
  const toNorm = (e: React.MouseEvent) => {
    const rect = containerRef.current!.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (e.clientX - rect.left)  / rect.width)),
      y: Math.max(0, Math.min(1, (e.clientY - rect.top)   / rect.height)),
    };
  };

  // ── mouse handlers ────────────────────────────────────────────────────────

  const handleMouseDown = (e: React.MouseEvent) => {
    if (!addMode) return;
    e.preventDefault();
    const { x, y } = toNorm(e);
    dragStart.current = { x, y };
    setDragBox({ x1: x, y1: y, x2: x, y2: y });
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!dragStart.current) return;
    const { x, y } = toNorm(e);
    setDragBox({ x1: dragStart.current.x, y1: dragStart.current.y, x2: x, y2: y });
  };

  const handleMouseUp = (e: React.MouseEvent) => {
    if (!dragStart.current) return;
    const { x, y } = toNorm(e);
    const start = dragStart.current;
    dragStart.current = null;
    setDragBox(null);

    const rect = containerRef.current!.getBoundingClientRect();
    const dxPx = Math.abs(x - start.x) * rect.width;
    const dyPx = Math.abs(y - start.y) * rect.height;

    if (Math.hypot(dxPx, dyPx) >= MIN_DRAG_PX) {
      const x1 = Math.min(start.x, x), y1 = Math.min(start.y, y);
      const x2 = Math.max(start.x, x), y2 = Math.max(start.y, y);
      onAddDetection({
        x_center: (x1 + x2) / 2,
        y_center: (y1 + y2) / 2,
        width:    x2 - x1,
        height:   y2 - y1,
      });
    }
  };

  const handleMouseLeave = () => {
    if (dragStart.current) {
      dragStart.current = null;
      setDragBox(null);
    }
  };

  // Clicking the container background deselects (select-mode only)
  const handleContainerClick = () => {
    if (!addMode) onSelectDetection(null);
  };

  // Clicking a specific box selects / deselects it (select-mode only)
  const handleBoxClick = (e: React.MouseEvent, det: Detection) => {
    e.stopPropagation();
    if (addMode) return;
    onSelectDetection(det.id === selectedId ? null : det.id);
  };

  const visible = detections.filter((d) => !d.is_deleted);

  // Image failed to load: a clear placeholder instead of a broken-image icon
  // with boxes floating over nothing. Boxes can't be drawn or edited without it.
  if (failedSrc === displaySrc) {
    return (
      <div className="w-full p-4">
        <div className="w-full aspect-[4/3] max-h-[70vh] flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed border-slate-300 bg-slate-100 px-6 text-center">
          <ImageOff size={40} strokeWidth={1.5} className="text-slate-400" />
          {knownUnreadable ? (
            <>
              <p className="text-sm font-semibold text-slate-700">This image can&apos;t be displayed</p>
              <p className="text-xs text-slate-500 max-w-sm">
                The detector also couldn&apos;t read this file, so it&apos;s likely damaged or not a valid
                image. If you have the original, upload it again in a new batch.
              </p>
            </>
          ) : (
            <>
              <p className="text-sm font-semibold text-slate-700">This image couldn&apos;t be loaded</p>
              <p className="text-xs text-slate-500 max-w-sm">
                This usually means a slow or interrupted connection, and the file itself is fine.
                Try again in a moment.
              </p>
            </>
          )}
          <button
            onClick={() => setRetry({ src: imageSrc, n: attempt + 1 })}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-white text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors"
          >
            <RotateCw size={13} strokeWidth={2} />
            Retry
          </button>
          {attempt > 0 && (
            <p className="text-[11px] text-slate-400 tabular-nums">
              Tried {attempt + 1} times
              {!knownUnreadable && attempt >= 2 && " — if this keeps failing, the file may be missing or damaged"}
            </p>
          )}
          {visible.length > 0 && (
            <p className="text-xs font-medium text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-2 py-1">
              {visible.length} box{visible.length !== 1 ? "es" : ""} from an earlier run still belong{visible.length === 1 ? "s" : ""} to
              this image and can&apos;t be checked here
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="w-full">
      {/*
        Outer wrapper: relative so the overlay and legend can use absolute positioning.
        Width is 100% of the panel; height is determined by the image (auto).
        The parent panel must have overflow-y: auto so tall images scroll.
      */}
      <div
        ref={containerRef}
        className="relative w-full select-none"
        style={{ cursor: addMode ? "crosshair" : "default" }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseLeave}
        onClick={handleContainerClick}
      >
        {/* ── Image ── 100% panel width, auto height, aspect ratio preserved */}
        <img
          src={displaySrc}
          alt="microscopy image"
          draggable={false}
          style={{ display: "block", width: "100%", height: "auto" }}
          onError={() => setFailedSrc(displaySrc)}
        />

        {/* ── Overlap shading ── areas also visible in another image */}
        {overlapRegions.length > 0 && (
          <div className="absolute inset-0 overflow-hidden" style={{ pointerEvents: "none" }}>
            <svg
              className="absolute inset-0 w-full h-full"
              viewBox="0 0 1 1"
              preserveAspectRatio="none"
            >
              {overlapRegions.map((r) => (
                <polygon
                  key={r.key}
                  points={r.points.map(([x, y]) => `${x},${y}`).join(" ")}
                  fill={COLOR_OVERLAP}
                  fillOpacity={r.active ? 0.22 : 0.12}
                  stroke={COLOR_OVERLAP}
                  strokeWidth={r.active ? 2.5 : 1.5}
                  strokeDasharray="6 4"
                  vectorEffect="non-scaling-stroke"
                />
              ))}
            </svg>
            {overlapRegions.map((r) => {
              const pos = labelPos(r.points);
              return (
                <span
                  key={`lbl-${r.key}`}
                  className="absolute text-[10px] font-semibold text-white px-1.5 py-0.5 rounded whitespace-nowrap"
                  style={{ left: `${pos.x * 100}%`, top: `${pos.y * 100}%`, background: COLOR_OVERLAP, opacity: 0.9 }}
                >
                  {r.label}
                </span>
              );
            })}
          </div>
        )}

        {/* ── Detection overlays ── positioned in % relative to the image */}
        <div className="absolute inset-0" style={{ pointerEvents: "none" }}>
          {visible.map((det) => {
            const color      = boxColor(det, threshold);
            const isSelected = det.id === selectedId;
            const isReview   = color === COLOR_REVIEW;
            const isDup      = det.is_duplicate;
            const isLinked   = highlightIds.includes(det.id);

            // YOLO coords are normalised (0-1): convert to CSS %
            const left   = (det.x_center - det.width  / 2) * 100;
            const top    = (det.y_center - det.height / 2) * 100;
            const width  = det.width  * 100;
            const height = det.height * 100;

            const label =
              det.source === "manual"
                ? "100%"
                : det.confidence !== null
                ? `${Math.round(det.confidence * 100)}%`
                : "";

            return (
              <div
                key={det.id}
                style={{
                  position:   "absolute",
                  left:       `${left}%`,
                  top:        `${top}%`,
                  width:      `${width}%`,
                  height:     `${height}%`,
                  boxSizing:  "border-box",
                  border:     isLinked
                    ? `3px solid ${COLOR_HIGHLIGHT}`
                    : `${isSelected ? 2.5 : 1.5}px ${isDup ? "dashed" : "solid"} ${color}`,
                  // White glow ring behind the selected / linked box
                  boxShadow:  isSelected || isLinked ? `0 0 0 2px white` : "none",
                  cursor:     addMode ? "crosshair" : "pointer",
                  // Let clicks through in add-mode; capture in select-mode
                  pointerEvents: addMode ? "none" : "auto",
                }}
                onClick={(e) => handleBoxClick(e, det)}
              >
                {/* Confidence label — sits just above the top-left corner */}
                {label && (
                  <span
                    style={{
                      position:   "absolute",
                      bottom:     "100%",
                      left:       0,
                      background: color,
                      color:      "#fff",
                      fontSize:   "10px",
                      lineHeight: 1,
                      padding:    "1px 3px",
                      whiteSpace: "nowrap",
                      display:    "block",
                    }}
                  >
                    {label}
                  </span>
                )}

                {/* "DUP" tag on duplicate boxes (bottom-right) */}
                {isDup && !isSelected && (
                  <span
                    style={{
                      position:     "absolute",
                      bottom:       2,
                      right:        2,
                      background:   COLOR_DUP,
                      color:        "#fff",
                      fontSize:     "8px",
                      fontWeight:   "bold",
                      lineHeight:   1,
                      padding:      "2px 3px",
                      borderRadius: 2,
                      display:      "block",
                    }}
                  >
                    DUP
                  </span>
                )}

                {/* "REVIEW" tag on amber boxes (bottom-right) */}
                {isReview && !isSelected && (
                  <span
                    style={{
                      position:     "absolute",
                      bottom:       2,
                      right:        2,
                      background:   COLOR_REVIEW,
                      color:        "#fff",
                      fontSize:     "8px",
                      fontWeight:   "bold",
                      lineHeight:   1,
                      padding:      "2px 3px",
                      borderRadius: 2,
                      display:      "block",
                    }}
                  >
                    REVIEW
                  </span>
                )}
              </div>
            );
          })}
        </div>

        {/* ── In-progress drag box (add-mode only) */}
        {dragBox && addMode && (
          <div
            style={{
              position:   "absolute",
              left:       `${Math.min(dragBox.x1, dragBox.x2) * 100}%`,
              top:        `${Math.min(dragBox.y1, dragBox.y2) * 100}%`,
              width:      `${Math.abs(dragBox.x2 - dragBox.x1) * 100}%`,
              height:     `${Math.abs(dragBox.y2 - dragBox.y1) * 100}%`,
              border:     "2px dashed #6366f1",
              boxSizing:  "border-box",
              pointerEvents: "none",
            }}
          />
        )}

        {/* ── Legend (bottom-left of the image) */}
        {!hideLegend && <div
          className="absolute bottom-3 left-3 flex items-center gap-3 bg-black/50 text-white text-xs px-2.5 py-1.5 rounded-lg backdrop-blur-sm"
          style={{ pointerEvents: "none" }}
        >
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-3 h-3 rounded-sm" style={{ background: COLOR_ACCEPTED }} />
            Accepted
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-3 h-3 rounded-sm" style={{ background: COLOR_REVIEW }} />
            Needs review
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-3 h-3 rounded-sm" style={{ background: COLOR_MANUAL }} />
            Manual
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-3 h-3 rounded-sm" style={{ background: COLOR_DUP }} />
            Duplicate
          </span>
          {overlapRegions.length > 0 && (
            <span className="flex items-center gap-1.5">
              <span className="inline-block w-3 h-3 rounded-sm border border-dashed" style={{ background: `${COLOR_OVERLAP}55`, borderColor: COLOR_OVERLAP }} />
              Overlap
            </span>
          )}
          {addMode ? (
            <span className="text-indigo-300 font-semibold">Draw to add</span>
          ) : (
            <span className="text-gray-300">Click box to select</span>
          )}
        </div>}
      </div>
    </div>
  );
}
