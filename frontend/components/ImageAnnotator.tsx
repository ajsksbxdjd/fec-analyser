"use client";

import { useRef, useState } from "react";
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
}

// Box colour by state
const COLOR_ACCEPTED = "#22c55e"; // green-500
const COLOR_REVIEW   = "#f59e0b"; // amber-400
const COLOR_MANUAL   = "#3b82f6"; // blue-500
const MIN_DRAG_PX    = 5;

function boxColor(det: Detection, threshold: number): string {
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
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const dragStart    = useRef<{ x: number; y: number } | null>(null);
  const [dragBox, setDragBox] = useState<DragBox | null>(null);

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
          src={imageSrc}
          alt="microscopy image"
          draggable={false}
          style={{ display: "block", width: "100%", height: "auto" }}
        />

        {/* ── Detection overlays ── positioned in % relative to the image */}
        <div className="absolute inset-0" style={{ pointerEvents: "none" }}>
          {visible.map((det) => {
            const color      = boxColor(det, threshold);
            const isSelected = det.id === selectedId;
            const isReview   = color === COLOR_REVIEW;

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
                  border:     `${isSelected ? 2.5 : 1.5}px solid ${color}`,
                  // White glow ring behind the selected box
                  boxShadow:  isSelected ? `0 0 0 2px white` : "none",
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
        <div
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
          {addMode ? (
            <span className="text-indigo-300 font-semibold">Draw to add</span>
          ) : (
            <span className="text-gray-300">Click box to select</span>
          )}
        </div>
      </div>
    </div>
  );
}
