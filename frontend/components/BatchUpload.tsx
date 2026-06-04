"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { UploadCloud } from "lucide-react";
import {
  createBatch,
  uploadImagesWithProgress,
  runInference,
  getBatchStatus,
} from "@/lib/api";

interface Props {
  /** Called when inference finishes — parent navigates to the dashboard. */
  onDone: (batchId: number) => void;
}

type Stage = "idle" | "uploading" | "inferring" | "completed" | "error";

function fmtDuration(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function BatchUpload({ onDone }: Props) {
  const [name, setName] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [stage, setStage] = useState<Stage>("idle");
  const [uploadPct, setUploadPct] = useState(0);
  const [inferProgress, setInferProgress] = useState({ done: 0, total: 0 });
  const [clientElapsed, setClientElapsed] = useState(0);
  const [completedInfo, setCompletedInfo] = useState<{ elapsed: number; total: number } | null>(null);
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const clientTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const clientElapsedRef = useRef(0);

  const stopPolling = () => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  };

  const stopTimer = () => {
    if (clientTimerRef.current) { clearInterval(clientTimerRef.current); clientTimerRef.current = null; }
  };

  // Start / stop the elapsed timer based on stage
  useEffect(() => {
    if (stage === "inferring") {
      clientElapsedRef.current = 0;
      setClientElapsed(0);
      clientTimerRef.current = setInterval(() => {
        clientElapsedRef.current += 1;
        setClientElapsed(clientElapsedRef.current);
      }, 1000);
    } else {
      stopTimer();
    }
    return stopTimer;
  }, [stage]);

  const handleFiles = (incoming: FileList | null) => {
    if (!incoming) return;
    setFiles(Array.from(incoming));
  };

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    handleFiles(e.dataTransfer.files);
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) { setError("Enter a sample label."); return; }
    if (files.length === 0) { setError("Add at least one file."); return; }
    setError("");

    try {
      const batch = await createBatch(name.trim());
      const batchId = batch.id;

      setStage("uploading");
      setUploadPct(0);
      await uploadImagesWithProgress(batchId, files, setUploadPct);

      setStage("inferring");
      const progress = await runInference(batchId);
      setInferProgress({ done: progress.processed_count, total: progress.image_count });

      pollRef.current = setInterval(async () => {
        try {
          const status = await getBatchStatus(batchId);
          setInferProgress({ done: status.processed_count, total: status.image_count });
          if (status.status === "done") {
            stopPolling();
            stopTimer();
            const elapsed = status.elapsed_seconds ?? clientElapsedRef.current;
            setCompletedInfo({ elapsed, total: status.image_count });
            setStage("completed");
            // Brief completed flash before navigating
            setTimeout(() => onDone(batchId), 1800);
          }
        } catch { /* keep polling */ }
      }, 1500);

    } catch (err) {
      stopPolling();
      stopTimer();
      setStage("error");
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  // ── Idle / Error ─────────────────────────────────────────────────────────────
  if (stage === "idle" || stage === "error") {
    return (
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        {/* Sample label */}
        <div>
          <label className="block text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-1.5">
            Sample label
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Patient 007 — Batch A"
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent transition"
          />
        </div>

        {/* Drop zone */}
        <div
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          onClick={() => fileInputRef.current?.click()}
          className={`relative flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-4 py-8 cursor-pointer transition-colors ${
            dragging
              ? "border-blue-500 bg-blue-50"
              : files.length > 0
              ? "border-green-400 bg-green-50"
              : "border-gray-200 bg-slate-50 hover:border-blue-400 hover:bg-blue-50/40"
          }`}
        >
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="image/jpeg,image/png,.zip"
            className="hidden"
            onChange={(e) => handleFiles(e.target.files)}
          />
          {files.length > 0 ? (
            <>
              <span className="text-2xl">✅</span>
              <p className="text-sm font-medium text-green-700">
                {files.length} file{files.length !== 1 ? "s" : ""} ready
              </p>
              <p className="text-xs text-green-600 break-all text-center max-w-full line-clamp-2">
                {files.map((f) => f.name).join(", ")}
              </p>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setFiles([]);
                  if (fileInputRef.current) fileInputRef.current.value = "";
                }}
                className="text-xs text-slate-400 hover:text-red-500 mt-1 transition-colors"
              >
                Clear
              </button>
            </>
          ) : (
            <>
              <UploadCloud size={32} strokeWidth={1.5} className="text-slate-300" />
              <p className="text-sm font-medium text-slate-600">
                Drop images or a ZIP here
              </p>
              <p className="text-xs text-slate-400">
                JPG · PNG · ZIP — up to 200 images, 50 MB each
              </p>
            </>
          )}
        </div>

        {error && (
          <p className="text-xs text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2">
            {error}
          </p>
        )}

        <button
          type="submit"
          className="w-full py-2.5 rounded-lg bg-blue-600 text-white text-sm font-semibold hover:bg-blue-700 active:bg-blue-800 transition-colors"
        >
          Start analysis
        </button>
      </form>
    );
  }

  // ── Uploading ────────────────────────────────────────────────────────────────
  if (stage === "uploading") {
    return (
      <div className="flex flex-col items-center gap-4 py-6">
        <div className="h-9 w-9 rounded-full border-[3px] border-blue-600 border-t-transparent animate-spin" />
        <p className="text-sm font-semibold text-slate-700">Uploading files…</p>
        <div className="w-full bg-slate-100 rounded-full h-2">
          <div
            className="bg-blue-600 h-2 rounded-full transition-all duration-300"
            style={{ width: `${uploadPct}%` }}
          />
        </div>
        <p className="text-xs text-slate-400 tabular-nums">{uploadPct}%</p>
      </div>
    );
  }

  // ── Inferring ────────────────────────────────────────────────────────────────
  if (stage === "inferring") {
    const { done, total } = inferProgress;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    return (
      <div className="flex flex-col items-center gap-4 py-6">
        <div className="h-9 w-9 rounded-full border-[3px] border-blue-600 border-t-transparent animate-spin" />
        <p className="text-sm font-semibold text-slate-700">Running YOLOv8 detection…</p>
        <div className="w-full bg-slate-100 rounded-full h-2">
          <div
            className="bg-blue-600 h-2 rounded-full transition-all duration-300"
            style={{ width: `${pct}%` }}
          />
        </div>
        <p className="text-xs text-slate-400 tabular-nums">
          {total > 0 ? `${done} / ${total} images` : "Starting…"}
          {clientElapsed > 0 && <span className="ml-2">· {fmtDuration(clientElapsed)}</span>}
        </p>
      </div>
    );
  }

  // ── Completed (brief flash before navigation) ─────────────────────────────
  if (stage === "completed" && completedInfo) {
    return (
      <div className="flex flex-col items-center gap-2 py-6">
        <p className="text-sm font-semibold text-slate-900 tabular-nums">
          Completed in {fmtDuration(completedInfo.elapsed)} · {completedInfo.total} images
        </p>
        <p className="text-xs text-slate-400">Opening dashboard…</p>
      </div>
    );
  }

  return null;
}
