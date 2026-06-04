"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { listBatches, deleteBatch, renameBatch } from "@/lib/api";
import type { BatchListRow } from "@/lib/types";
import BatchUpload from "@/components/BatchUpload";
import InlineEdit from "@/components/InlineEdit";
import { RefreshCw, Trash2 } from "lucide-react";

const STATUS_CONFIG: Record<string, { label: string; cls: string }> = {
  pending:    { label: "Pending",    cls: "bg-slate-100 text-slate-500"  },
  processing: { label: "Processing", cls: "bg-blue-50  text-blue-600"   },
  done:       { label: "Complete",   cls: "bg-green-50 text-green-700"  },
  reviewed:   { label: "Complete",   cls: "bg-green-50 text-green-700"  },
};

const SEVERITY_CONFIG: Record<string, { cls: string }> = {
  Light:    { cls: "bg-green-50 text-green-700"  },
  Moderate: { cls: "bg-amber-50 text-amber-700"  },
  Heavy:    { cls: "bg-red-50   text-red-700"    },
};

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric", month: "short", day: "numeric",
  });
}

export default function WorkspacePage() {
  const router = useRouter();
  const [batches, setBatches] = useState<BatchListRow[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [deletingId, setDeletingId] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await listBatches();
      setBatches(data);
    } catch {
      // silently — table just stays stale
    } finally {
      setLoadingList(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const handleDone = (batchId: number) => {
    router.push(`/batches/${batchId}`);
  };

  const handleDelete = async (id: number) => {
    if (!confirm("Delete this analysis and all its images?")) return;
    setDeletingId(id);
    try {
      await deleteBatch(id);
      setBatches((prev) => prev.filter((b) => b.id !== id));
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="max-w-7xl mx-auto px-4 py-8">

        {/* Page header */}
        <div className="mb-8">
          <h1 className="text-[28px] font-bold text-slate-900 tracking-tight leading-tight">
            FEC Workspace
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            Upload microscopy images, run YOLOv8 detection, and review results
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-[360px_1fr] gap-6 items-start">

          {/* ── LEFT — New analysis card ──────────────────────────────────── */}
          <div className="bg-white rounded-xl border border-gray-200 shadow-[0_1px_4px_rgba(0,0,0,0.06)] p-6">
            <div className="mb-5">
              <h2 className="text-sm font-semibold text-slate-900 uppercase tracking-wide">
                New analysis
              </h2>
              <p className="text-xs text-slate-400 mt-1">
                Upload images or a ZIP archive to start detection
              </p>
            </div>
            <BatchUpload onDone={(id) => {
              refresh();
              handleDone(id);
            }} />
          </div>

          {/* ── RIGHT — Recent analyses table ────────────────────────────── */}
          <div className="bg-white rounded-xl border border-gray-200 shadow-[0_1px_4px_rgba(0,0,0,0.06)] overflow-hidden">
            <div className="px-5 py-4 border-b border-gray-200 flex items-center justify-between">
              <div>
                <h2 className="text-sm font-semibold text-slate-900 uppercase tracking-wide">
                  Recent analyses
                </h2>
                <p className="text-xs text-slate-400 mt-0.5">{batches.length} total</p>
              </div>
              <button
                onClick={refresh}
                className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-slate-600 transition-colors"
              >
                <RefreshCw size={11} strokeWidth={2} />
                Refresh
              </button>
            </div>

            {loadingList ? (
              <div className="flex justify-center py-16">
                <div className="h-5 w-5 rounded-full border-2 border-blue-600 border-t-transparent animate-spin" />
              </div>
            ) : batches.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-16 text-slate-400">
                <span className="text-4xl">🔬</span>
                <p className="text-sm">No analyses yet — start one on the left</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-slate-50 border-b border-gray-200">
                      {["Sample", "Status", "EPG", "Severity", "Date", ""].map((h, i) => (
                        <th
                          key={i}
                          className={`px-5 py-3 text-[10px] font-semibold text-slate-400 uppercase tracking-wider ${
                            h === "EPG" ? "text-right" : "text-left"
                          }`}
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {batches.map((b) => {
                      const statusCfg = STATUS_CONFIG[b.status] ?? STATUS_CONFIG.pending;
                      const sevCfg = SEVERITY_CONFIG[b.severity];
                      const isProcessing = b.status === "processing";
                      return (
                        <tr
                          key={b.id}
                          onClick={() => router.push(`/batches/${b.id}`)}
                          className="cursor-pointer hover:bg-slate-50 transition-colors"
                        >
                          {/* Sample */}
                          <td className="px-5 py-3.5">
                            <p className="font-medium text-slate-900 truncate max-w-[200px] text-sm">
                              <InlineEdit
                                value={b.name}
                                onSave={async (name) => {
                                  const updated = await renameBatch(b.id, name);
                                  setBatches((prev) =>
                                    prev.map((x) => x.id === b.id ? { ...x, name: updated.name } : x)
                                  );
                                }}
                                displayClassName="font-medium text-slate-900 text-sm"
                                inputClassName="font-medium text-slate-900 text-sm bg-transparent border-b border-blue-600 focus:outline-none w-full"
                                onClickCapture={(e) => e.stopPropagation()}
                              />
                            </p>
                            <p className="text-xs text-slate-400 mt-0.5">
                              {b.image_count} image{b.image_count !== 1 ? "s" : ""}
                            </p>
                          </td>

                          {/* Status */}
                          <td className="px-5 py-3.5">
                            <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium ${statusCfg.cls}`}>
                              {isProcessing && (
                                <span className="h-1.5 w-1.5 rounded-full bg-blue-500 animate-ping" />
                              )}
                              {statusCfg.label}
                            </span>
                          </td>

                          {/* EPG */}
                          <td className="px-5 py-3.5 text-right tabular-nums font-medium text-slate-900">
                            {b.status === "done" || b.status === "reviewed"
                              ? b.epg.toLocaleString()
                              : <span className="text-slate-300">—</span>
                            }
                          </td>

                          {/* Severity */}
                          <td className="px-5 py-3.5">
                            {sevCfg && (b.status === "done" || b.status === "reviewed") ? (
                              <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${sevCfg.cls}`}>
                                {b.severity}
                              </span>
                            ) : (
                              <span className="text-slate-300 text-xs">—</span>
                            )}
                          </td>

                          {/* Date */}
                          <td className="px-5 py-3.5 text-slate-400 text-xs whitespace-nowrap">
                            {formatDate(b.created_at)}
                          </td>

                          {/* Delete */}
                          <td className="px-5 py-3.5 text-right">
                            <button
                              onClick={(e) => { e.stopPropagation(); handleDelete(b.id); }}
                              disabled={deletingId === b.id}
                              className="text-slate-300 hover:text-red-500 transition-colors disabled:opacity-40"
                              title="Delete"
                            >
                              <Trash2 size={14} strokeWidth={1.75} />
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
