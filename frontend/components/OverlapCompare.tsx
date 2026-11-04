"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { decideOverlap, getImage } from "@/lib/api";
import type { Detection, ImageDetail, OverlapPartner, OverlapStatus } from "@/lib/types";
import ImageAnnotator from "@/components/ImageAnnotator";

interface Props {
  batchId: number;
  current: ImageDetail;            // the image the reviewer is on
  partner: OverlapPartner;         // the overlapping image to compare with
  threshold: number;
  focusDetectionId?: number | null; // highlight only this duplicate pair
  onClose: () => void;
  onOpenPartner: (imageId: number) => void;
  onDecided: () => Promise<void> | void; // refresh counts after confirm / reject
}

/**
 * Side-by-side view of two overlapping images.
 *
 * - shades the area each image shares with the other
 * - rings duplicate eggs linked across the two images
 * - "Same area" / "Different area": the reviewer's call. "Different area"
 *   makes duplicates that came from this pair count again.
 */
export default function OverlapCompare({
  batchId,
  current,
  partner,
  threshold,
  focusDetectionId = null,
  onClose,
  onOpenPartner,
  onDecided,
}: Props) {
  const [other, setOther] = useState<ImageDetail | null>(null);
  const [error, setError] = useState("");
  const [deciding, setDeciding] = useState(false);
  const [decideError, setDecideError] = useState("");

  useEffect(() => {
    setOther(null);
    setError("");
    getImage(partner.image_id)
      .then(setOther)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [partner.image_id]);

  // Refresh the partner image too after a decision (its duplicate flags change)
  const reloadOther = useCallback(() => {
    getImage(partner.image_id).then(setOther).catch(() => {});
  }, [partner.image_id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // ── duplicate links between the two images: [box here, box there] ─────────
  const links = useMemo(() => {
    if (!other) return [] as [number, number][];
    const live = (ds: Detection[]) => ds.filter((d) => !d.is_deleted);
    const hereIds = new Set(live(current.detections).map((d) => d.id));
    const thereIds = new Set(live(other.detections).map((d) => d.id));
    const out: [number, number][] = [];
    for (const d of live(current.detections)) {
      if (d.is_duplicate && d.duplicate_of_id != null && thereIds.has(d.duplicate_of_id)) {
        out.push([d.id, d.duplicate_of_id]);
      }
    }
    for (const d of live(other.detections)) {
      if (d.is_duplicate && d.duplicate_of_id != null && hereIds.has(d.duplicate_of_id)) {
        out.push([d.duplicate_of_id, d.id]);
      }
    }
    return out;
  }, [current, other]);

  const shown = focusDetectionId != null
    ? links.filter(([a, b]) => a === focusDetectionId || b === focusDetectionId)
    : links;

  const rejected = partner.status === "rejected";
  const canDecide = partner.overlap_id > 0;

  const decide = async (status: OverlapStatus) => {
    if (!canDecide) return;
    setDeciding(true);
    setDecideError("");
    try {
      await decideOverlap(partner.overlap_id, status);
      await onDecided();
      reloadOther();
    } catch (e) {
      setDecideError(e instanceof Error ? e.message : String(e));
    } finally {
      setDeciding(false);
    }
  };

  const noop = () => {};

  return (
    <div
      className="fixed inset-0 z-[100] bg-black/60 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl shadow-2xl w-full max-w-7xl max-h-full flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── Header ───────────────────────────────────────────────────────── */}
        <div className="flex items-center justify-between gap-4 px-5 py-3 border-b border-gray-200">
          <div className="min-w-0">
            <div className="flex items-center gap-2 min-w-0">
              <p className="text-sm font-semibold text-slate-900 truncate">
                {current.filename} ↔ {partner.filename}
              </p>
              {canDecide && <StrengthBadge partner={partner} />}
              {partner.status === "confirmed" && (
                <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-green-50 text-green-700 border border-green-200 flex-shrink-0">
                  ✓ Same area
                </span>
              )}
              {rejected && (
                <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 border border-slate-300 flex-shrink-0">
                  ✕ Different area
                </span>
              )}
            </div>
            <p className="text-xs text-slate-500 tabular-nums mt-0.5">
              {!canDecide && "Linked through another overlapping image · "}
              {other
                ? rejected
                  ? "Eggs in both images are counted"
                  : `${links.length} duplicate egg${links.length !== 1 ? "s" : ""}`
                : "loading…"}
              {focusDetectionId != null && links.length > shown.length && " (showing the selected one)"}
            </p>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <button
              onClick={() => onOpenPartner(partner.image_id)}
              className="text-xs px-3 py-1.5 bg-slate-100 text-slate-700 rounded-lg hover:bg-slate-200 font-medium"
            >
              Open other image →
            </button>
            <button
              onClick={onClose}
              className="text-xs px-3 py-1.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-semibold"
            >
              Close
            </button>
          </div>
        </div>

        {/* ── Decision bar ─────────────────────────────────────────────────── */}
        {canDecide && (
          <div className="flex items-center gap-3 px-5 py-2.5 border-b border-gray-200 bg-slate-50 flex-wrap">
            <p className="text-xs font-semibold text-slate-800 flex-1 min-w-[200px]">
              Same area of the slide?
            </p>
            {partner.status === "auto" ? (
              <>
                <button
                  disabled={deciding}
                  onClick={() => decide("confirmed")}
                  className="text-xs px-3 py-1.5 bg-green-600 text-white rounded-lg hover:bg-green-700 font-semibold disabled:opacity-50"
                >
                  ✓ Same area
                </button>
                <button
                  disabled={deciding}
                  onClick={() => decide("rejected")}
                  className="text-xs px-3 py-1.5 bg-red-50 text-red-700 border border-red-200 rounded-lg hover:bg-red-100 font-semibold disabled:opacity-50"
                >
                  ✕ Different area
                </button>
              </>
            ) : (
              <button
                disabled={deciding}
                onClick={() => decide("auto")}
                className="text-xs px-3 py-1.5 bg-white text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-100 font-semibold disabled:opacity-50"
              >
                ↺ Undo decision
              </button>
            )}
            {deciding && <span className="text-xs text-slate-400">Updating…</span>}
            {decideError && <span className="text-xs text-red-600">{decideError}</span>}
          </div>
        )}

        {/* ── Two images ───────────────────────────────────────────────────── */}
        <div className="overflow-y-auto bg-slate-50">
          <div className="grid grid-cols-2 gap-6 p-3">
            {[
              { key: "here", label: "This image", name: current.filename, detail: current as ImageDetail | null, region: partner.region_here, hl: shown.map(([a]) => a) },
              { key: "there", label: "Overlapping image", name: partner.filename, detail: other, region: partner.region_there, hl: shown.map(([, b]) => b) },
            ].map((side) => (
              <div key={side.key} className="min-w-0">
                <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-1 truncate">
                  {side.label} · <span className="normal-case text-slate-600">{side.name}</span>
                </p>
                <div>
                  {side.detail ? (
                    <ImageAnnotator
                      imageSrc={`/uploads/${batchId}/${side.detail.filename}`}
                      detections={side.detail.detections}
                      threshold={threshold}
                      addMode={false}
                      selectedId={null}
                      onSelectDetection={noop}
                      onAddDetection={noop}
                      overlapRegions={
                        side.region.length && !rejected
                          ? [{ key: "shared", points: side.region, label: "shared area", active: true }]
                          : []
                      }
                      highlightIds={rejected ? [] : side.hl}
                      hideLegend
                    />
                  ) : (
                    <div className="flex items-center justify-center h-64 text-xs text-slate-400">
                      {error || "Loading…"}
                    </div>
                  )}
                </div>
              </div>
            ))}

          </div>
        </div>

        {/* ── Legend ───────────────────────────────────────────────────────── */}
        <div className="flex items-center gap-4 px-5 py-2.5 border-t border-gray-200 text-xs text-slate-500 flex-wrap">
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-3 h-3 rounded-sm border border-dashed border-violet-500 bg-violet-500/25" />
            Shared area
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-3 h-3 rounded-sm border-2 border-fuchsia-500" />
            Same egg (grey copy not counted)
          </span>
          <span className="ml-auto text-slate-400">Esc to close</span>
        </div>
      </div>
    </div>
  );
}

export function StrengthBadge({ partner }: { partner: OverlapPartner }) {
  return partner.strength === "strong" ? (
    <span
      className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-violet-50 text-violet-700 border border-violet-200 flex-shrink-0"
    >
      Strong match
    </span>
  ) : (
    <span
      className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-300 flex-shrink-0"
    >
      ⚠ Weak match
    </span>
  );
}
