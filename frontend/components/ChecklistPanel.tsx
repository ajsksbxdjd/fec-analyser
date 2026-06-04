"use client";

import { Fragment } from "react";
import Image from "next/image";
import type { ImageListRow } from "@/lib/types";

interface Props {
  images: ImageListRow[];
  currentIndex: number;
  onSelect: (index: number) => void;
}

// ── section helpers ────────────────────────────────────────────────────────────

type Section = "review" | "auto" | "checked";

function imageSection(img: ImageListRow): Section {
  if (img.needs_review) return "review";
  if (img.is_checked)   return "checked";
  return "auto";
}

const SECTION_HEADER: Record<Section, { label: string; className: string }> = {
  review:  { label: "⚠ Needs review", className: "text-amber-600"  },
  auto:    { label: "Auto-Accepted",   className: "text-green-600"  },
  checked: { label: "✓ Reviewed",      className: "text-blue-600"   },
};

export default function ImageListPanel({ images, currentIndex, onSelect }: Props) {
  const reviewCount   = images.filter((img) =>  img.needs_review).length;
  const reviewedCount = images.filter((img) => !img.needs_review).length;

  return (
    <div className="flex flex-col h-full overflow-hidden">

      {/* Header summary */}
      <div className="px-3 py-3 border-b border-gray-200 flex-shrink-0">
        <div className="flex items-center justify-between mb-2">
          <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">
            {images.length} image{images.length !== 1 ? "s" : ""}
          </p>
          {reviewCount > 0 ? (
            <span className="text-[10px] font-medium text-amber-600 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-full">
              ⚠ {reviewCount} need review
            </span>
          ) : (
            <span className="text-[10px] font-medium text-green-700 bg-green-50 px-2 py-0.5 rounded-full">
              ✓ All clear
            </span>
          )}
        </div>
        {/* Progress bar */}
        <div className="w-full bg-slate-100 rounded-full h-1">
          <div
            className="bg-green-600 h-1 rounded-full transition-all duration-300"
            style={{
              width: images.length > 0
                ? `${Math.round((reviewedCount / images.length) * 100)}%`
                : "0%",
            }}
          />
        </div>
        <p className="text-[10px] text-slate-400 mt-1">
          {images.length > 0
            ? `${Math.round((reviewedCount / images.length) * 100)}%`
            : "0%"}{" "}
          reviewed
        </p>
      </div>

      {/* Image list with section labels */}
      <div className="flex-1 overflow-y-auto">
        {(() => {
          let lastSection: Section | null = null;

          return images.map((img, idx) => {
            const section = imageSection(img);
            const showHeader = section !== lastSection;
            lastSection = section;
            const hdr = SECTION_HEADER[section];

            return (
              <Fragment key={img.id}>
                {/* Section label / divider */}
                {showHeader && (
                  <div className={`flex items-center gap-2 px-3 ${idx === 0 ? "pt-2.5 pb-1" : "pt-3 pb-1"}`}>
                    {idx > 0 && <div className="flex-1 h-px bg-gray-200" />}
                    <span className={`text-[9px] font-bold uppercase tracking-wider ${hdr.className}`}>
                      {hdr.label}
                    </span>
                    {idx > 0 && <div className="flex-1 h-px bg-gray-200" />}
                  </div>
                )}

                {/* Image row */}
                <button
                  onClick={() => onSelect(idx)}
                  className={`w-full flex items-center gap-2.5 px-3 py-2.5 text-left transition-colors ${
                    idx === currentIndex
                      ? "bg-blue-50 border-l-2 border-blue-600"
                      : "hover:bg-slate-50 border-l-2 border-transparent"
                  }`}
                >
                  {/* Thumbnail */}
                  <div className="relative h-10 w-10 flex-shrink-0 rounded-md overflow-hidden bg-slate-100">
                    <Image
                      src={`/uploads/${img.batch_id}/${img.filename}`}
                      alt={img.filename}
                      fill
                      className="object-cover"
                      unoptimized
                    />
                  </div>

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium text-slate-700 truncate">{img.filename}</p>
                    <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                      <span className="text-[10px] text-blue-600 bg-blue-50 px-1.5 py-px rounded font-medium tabular-nums">
                        {img.egg_count} egg{img.egg_count !== 1 ? "s" : ""}
                      </span>
                      {img.needs_review && (
                        <span className="text-[10px] text-amber-600 bg-amber-50 border border-amber-200 px-1.5 py-px rounded font-medium tabular-nums">
                          ⚠ {img.review_count}
                        </span>
                      )}
                      {img.is_checked && !img.needs_review && (
                        <span className="text-[10px] text-blue-600 bg-blue-50 px-1.5 py-px rounded font-medium">
                          ✓
                        </span>
                      )}
                    </div>
                  </div>
                </button>
              </Fragment>
            );
          });
        })()}
      </div>
    </div>
  );
}
