"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  getBatchSummary,
  listImages,
  getImage,
  addDetection,
  confirmDetection,
  deleteDetection,
  updateThreshold,
  toggleImageCheck,
  renameBatch,
  getBatchStatus,
  downloadReport,
  runDedup,
  getDedupStatus,
  waitForDedup,
  markNotDuplicate,
  getImageOverlaps,
} from "@/lib/api";
import type {
  ImageListRow,
  ImageDetail,
  Detection,
  DetectionCreate,
  Summary,
  OverlapPartner,
} from "@/lib/types";
import ImageAnnotator from "@/components/ImageAnnotator";
import OverlapCompare from "@/components/OverlapCompare";
import ImageListPanel from "@/components/ChecklistPanel";
import InlineEdit from "@/components/InlineEdit";
import { Hash, Calculator, CheckCircle2, TrendingUp, Download, Plus, Loader2, X, AlertTriangle } from "lucide-react";

// ── helpers ───────────────────────────────────────────────────────────────────
function fmtDuration(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// ── infection intensity config ────────────────────────────────────────────────
type Intensity = "light" | "moderate" | "heavy";

function getIntensity(epg: number): Intensity {
  if (epg < 2000) return "light";
  if (epg < 4000) return "moderate";
  return "heavy";
}

const INTENSITY_CONFIG: Record<
  Intensity,
  { label: string; emoji: string; bg: string; text: string; border: string; bar: string }
> = {
  light:    { label: "Light",    emoji: "🟢", bg: "bg-green-50", text: "text-green-700", border: "border-green-200", bar: "bg-green-600"  },
  moderate: { label: "Moderate", emoji: "🟡", bg: "bg-amber-50", text: "text-amber-700", border: "border-amber-200", bar: "bg-amber-600"  },
  heavy:    { label: "Heavy",    emoji: "🔴", bg: "bg-red-50",   text: "text-red-700",   border: "border-red-200",   bar: "bg-red-600"    },
};

// ── helpers ───────────────────────────────────────────────────────────────────
function fmtConf(c: number | null) {
  return c !== null ? `${Math.round(c * 100)}%` : "manual";
}

export default function DashboardPage() {
  const { id } = useParams<{ id: string }>();
  const batchId = Number(id);
  const router = useRouter();

  const [summary, setSummary] = useState<Summary | null>(null);
  const [imageList, setImageList] = useState<ImageListRow[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [imageDetail, setImageDetail] = useState<ImageDetail | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [addMode, setAddMode] = useState(false);
  const [thresholdInput, setThresholdInput] = useState("70");
  const [loading, setLoading] = useState(true);
  const [processing, setProcessing] = useState(false);
  const [processingProgress, setProcessingProgress] = useState({ done: 0, total: 0 });
  const [clientElapsed, setClientElapsed] = useState(0);
  const [inferCompleted, setInferCompleted] = useState<{ elapsed: number; total: number } | null>(null);
  const [error, setError] = useState("");
  // Overlap check (cross-image dedup) — runs automatically after YOLO.
  //   idle     : not running (finished earlier, or nothing to report)
  //   running  : in progress — counts may still go down
  //   finished : just finished while this page was open — counts are final
  //   error    : failed — offer a retry
  const [dedupState, setDedupState] = useState<"idle" | "running" | "finished" | "error">("idle");
  const [dedupError, setDedupError] = useState("");
  const [overlaps, setOverlaps] = useState<OverlapPartner[]>([]);
  const [showOverlaps, setShowOverlaps] = useState(true);
  const [compare, setCompare] = useState<{ partner: OverlapPartner; focus: number | null } | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const clientTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const clientElapsedRef = useRef(0);

  // ── background dedup (runs automatically after YOLO) ───────────────────────
  // The dashboard opens as soon as YOLO is done; if the overlap check is still
  // running, show that and refresh the counts when it finishes.
  const currentImageIdRef = useRef<number | null>(null);
  const unmountedRef = useRef(false);
  useEffect(() => {
    unmountedRef.current = false; // reset: React dev mode mounts effects twice
    return () => { unmountedRef.current = true; };
  }, []);

  // There is no manual "dedup" button: the check always runs by itself. This
  // follows a running check, and starts one for batches that never had it
  // (older batches, or a check lost when the backend restarted). `retry`
  // starts a new check after a failure.
  const watchDedup = useCallback(async (retry = false) => {
    const cancelled = () => unmountedRef.current;
    try {
      const job = await getDedupStatus(batchId);
      if (job.state !== "running" && !retry) {
        if (job.state === "error") {
          setDedupError(job.error ?? "Unknown error");
          setDedupState("error");
          return;
        }
        const s = await getBatchSummary(batchId);
        if (s.overlap_pairs !== null) return;   // already checked earlier
      }
      setDedupError("");
      setDedupState("running");
      const r = job.state === "running"
        ? await waitForDedup(batchId, cancelled)
        : await runDedup(batchId, cancelled);   // 409 = already started → just waits
      if (!r || cancelled()) return;
      const [s, imgs] = await Promise.all([getBatchSummary(batchId), listImages(batchId)]);
      setSummary(s);
      setImageList(imgs);  // also reloads the open image's boxes + overlaps
      const idx = imgs.findIndex((row) => row.id === currentImageIdRef.current);
      if (idx !== -1) setCurrentIndex(idx);
      setDedupState("finished");
    } catch (e) {
      if (cancelled()) return;
      setDedupError(e instanceof Error ? e.message : String(e));
      setDedupState("error");
    }
  }, [batchId]);

  // ── initial load ──────────────────────────────────────────────────────────
  const loadDashboard = useCallback(async () => {
    try {
      const [s, imgs] = await Promise.all([
        getBatchSummary(batchId),
        listImages(batchId),
      ]);
      setSummary(s);
      setImageList(imgs);
      setThresholdInput(String(Math.round(s.threshold * 100)));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [batchId]);

  useEffect(() => {
    // Check status first — if processing, show progress and poll
    getBatchStatus(batchId)
      .then((prog) => {
        if (prog.status === "processing") {
          setProcessing(true);
          setProcessingProgress({ done: prog.processed_count, total: prog.image_count });
          setLoading(false);

          // Start 1-second elapsed timer; use a ref so the done-handler reads current value
          clientElapsedRef.current = 0;
          setClientElapsed(0);
          clientTimerRef.current = setInterval(() => {
            clientElapsedRef.current += 1;
            setClientElapsed(clientElapsedRef.current);
          }, 1000);

          pollRef.current = setInterval(async () => {
            try {
              const s = await getBatchStatus(batchId);
              setProcessingProgress({ done: s.processed_count, total: s.image_count });
              if (s.status === "done") {
                clearInterval(pollRef.current!);   pollRef.current = null;
                clearInterval(clientTimerRef.current!); clientTimerRef.current = null;
                setInferCompleted({
                  elapsed: s.elapsed_seconds ?? clientElapsedRef.current,
                  total: s.image_count,
                });
                await loadDashboard();   // data arrives first
                setProcessing(false);    // then reveal the dashboard (no blank flash)
                watchDedup();            // overlap check continues in the background
              }
            } catch { /* keep polling */ }
          }, 1500);
        } else {
          loadDashboard().then(() => watchDedup());
        }
      })
      .catch(() => loadDashboard());

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      if (clientTimerRef.current) clearInterval(clientTimerRef.current);
    };
  }, [batchId, loadDashboard, watchDedup]);

  // ── load image detail when selection changes ──────────────────────────────
  useEffect(() => {
    if (imageList.length === 0) return;
    const row = imageList[currentIndex];
    if (!row) return;
    currentImageIdRef.current = row.id;
    setSelectedId(null);
    getImage(row.id).then(setImageDetail).catch(console.error);
    getImageOverlaps(row.id).then(setOverlaps).catch(() => setOverlaps([]));
  }, [currentIndex, imageList]);

  // ── detection handlers ────────────────────────────────────────────────────
  const handleAdd = async (payload: DetectionCreate) => {
    if (!imageDetail) return;
    const det = await addDetection(imageDetail.id, payload);
    setImageDetail((prev) => prev ? { ...prev, detections: [...prev.detections, det] } : prev);
    // update list egg_count optimistically
    setImageList((prev) => prev.map((r, i) =>
      i === currentIndex ? { ...r, egg_count: r.egg_count + 1 } : r
    ));
    setSummary((prev) => prev ? { ...prev, total_eggs: prev.total_eggs + 1, epg: (prev.total_eggs + 1) * 24 } : prev);
  };

  const handleDelete = async (detId: number) => {
    await deleteDetection(detId);
    setSelectedId(null);
    setImageDetail((prev) =>
      prev ? { ...prev, detections: prev.detections.map((d) => d.id === detId ? { ...d, is_deleted: true } : d) } : prev
    );
    // Refresh list/summary so counts + ordering are accurate
    const [imgs, s] = await Promise.all([listImages(batchId), getBatchSummary(batchId)]);
    setImageList(imgs);
    setSummary(s);
    // Keep selection on the same image by id
    const currentId = imageList[currentIndex]?.id;
    if (currentId) {
      const newIdx = imgs.findIndex((r) => r.id === currentId);
      if (newIdx !== -1) setCurrentIndex(newIdx);
    }
  };

  const handleConfirm = async (detId: number) => {
    const det = await confirmDetection(detId);
    setSelectedId(null);
    setImageDetail((prev) =>
      prev ? { ...prev, detections: prev.detections.map((d) => d.id === detId ? det : d) } : prev
    );
    const [imgs, s] = await Promise.all([listImages(batchId), getBatchSummary(batchId)]);
    setImageList(imgs);
    setSummary(s);
    const currentId = imageList[currentIndex]?.id;
    if (currentId) {
      const newIdx = imgs.findIndex((r) => r.id === currentId);
      if (newIdx !== -1) setCurrentIndex(newIdx);
    }
  };

  // ── refresh list + summary + current image, keeping the same image selected ─
  const refreshKeepingImage = async () => {
    const currentId = imageList[currentIndex]?.id;
    const [imgs, s] = await Promise.all([listImages(batchId), getBatchSummary(batchId)]);
    setImageList(imgs);
    setSummary(s);
    const newIdx = currentId ? imgs.findIndex((r) => r.id === currentId) : -1;
    if (newIdx !== -1) setCurrentIndex(newIdx);
    if (currentId) {
      const [detail, ovs] = await Promise.all([
        getImage(currentId),
        getImageOverlaps(currentId).catch(() => [] as OverlapPartner[]),
      ]);
      setImageDetail(detail);
      setOverlaps(ovs);
      // keep an open compare panel in sync with the new status / counts
      setCompare((prev) => {
        if (!prev) return prev;
        const fresh = ovs.find((o) => o.overlap_id === prev.partner.overlap_id);
        return fresh ? { ...prev, partner: fresh } : prev;
      });
    }
  };

  // ── overlap compare ───────────────────────────────────────────────────────
  const openCompareForDuplicate = (det: Detection) => {
    if (det.duplicate_of_image_id == null) return;
    const partner =
      overlaps.find((o) => o.image_id === det.duplicate_of_image_id) ??
      // Linked through a third image of the same overlap group: no direct outline
      {
        overlap_id: 0,
        image_id: det.duplicate_of_image_id,
        filename: det.duplicate_of_filename ?? `image ${det.duplicate_of_image_id}`,
        inliers: 0,
        strength: "weak" as const,
        status: "auto" as const,
        region_here: [],
        region_there: [],
        matches: [],
      };
    setCompare({ partner, focus: det.id });
  };

  const openImageById = (imageId: number) => {
    const idx = imageList.findIndex((r) => r.id === imageId);
    if (idx !== -1) {
      setCompare(null);
      setCurrentIndex(idx);
      setSelectedId(null);
      setAddMode(false);
    }
  };

  const handleNotDuplicate = async (detId: number) => {
    const det = await markNotDuplicate(detId);
    setSelectedId(null);
    setImageDetail((prev) =>
      prev ? { ...prev, detections: prev.detections.map((d) => d.id === detId ? { ...d, ...det } : d) } : prev
    );
    await refreshKeepingImage();
  };

  // ── mark image as reviewed / unreviewed ──────────────────────────────────
  const handleToggleReviewed = async () => {
    const row = imageList[currentIndex];
    if (!row) return;
    await toggleImageCheck(row.id);
    const imgs = await listImages(batchId);
    // Keep the same image selected after the list re-orders
    const currentId = row.id;
    const newIdx = imgs.findIndex((r) => r.id === currentId);
    setImageList(imgs);
    if (newIdx !== -1) setCurrentIndex(newIdx);
  };

  // ── threshold change ──────────────────────────────────────────────────────
  const handleThresholdApply = async () => {
    const pct = parseFloat(thresholdInput);
    if (isNaN(pct) || pct < 0 || pct > 100) return;
    try {
      const newSummary = await updateThreshold(batchId, pct / 100);
      setSummary(newSummary);
      const imgs = await listImages(batchId);
      // Preserve the currently-viewed image by ID (list order may change)
      const currentId = imageList[currentIndex]?.id;
      const newIdx = currentId ? imgs.findIndex((r) => r.id === currentId) : -1;
      const finalIdx = newIdx !== -1 ? newIdx : 0;
      setImageList(imgs);
      setCurrentIndex(finalIdx);
    } catch (e) {
      console.error("Threshold update failed", e);
    }
  };

  // ── CSV download ──────────────────────────────────────────────────────────
  const handleDownload = async () => {
    try {
      const blob = await downloadReport(batchId);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `batch-${batchId}-${summary?.batch_name?.replace(/\s+/g, "_") ?? ""}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      alert(`Download failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // ── selected detection info ────────────────────────────────────────────────
  const selectedDet: Detection | undefined = selectedId != null
    ? imageDetail?.detections.find((d) => d.id === selectedId && !d.is_deleted)
    : undefined;

  const threshold = summary ? summary.threshold : 0.70;

  const isNeedsReview = (d: Detection) =>
    !d.is_duplicate && d.source === "yolo" && !d.is_confirmed && d.confidence !== null && d.confidence < threshold;

  // ── loading / error states ────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="flex items-center justify-center h-[calc(100vh-64px)]">
        <div className="h-8 w-8 rounded-full border-4 border-blue-600 border-t-transparent animate-spin" />
      </div>
    );
  }

  if (processing) {
    const { done, total } = processingProgress;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;

    // Show "Completed in X:XX" while loadDashboard() resolves
    if (inferCompleted) {
      return (
        <div className="flex flex-col items-center justify-center gap-3 h-[calc(100vh-64px)]">
          <p className="text-base font-semibold text-slate-900 tabular-nums">
            Completed in {fmtDuration(inferCompleted.elapsed)} · {inferCompleted.total} images
          </p>
          <p className="text-xs text-slate-400">Loading dashboard…</p>
        </div>
      );
    }

    return (
      <div className="flex flex-col items-center justify-center gap-6 h-[calc(100vh-64px)]">
        <div className="h-10 w-10 rounded-full border-[3px] border-blue-600 border-t-transparent animate-spin" />
        <div className="text-center">
          <p className="text-base font-semibold text-slate-900">Running YOLOv8 detection…</p>
          <p className="text-sm text-slate-500 mt-1 tabular-nums">
            {total > 0 ? `${done} / ${total} images` : "Starting…"}
            {clientElapsed > 0 && <span className="ml-2 text-slate-400">· {fmtDuration(clientElapsed)}</span>}
          </p>
        </div>
        <div className="w-72 bg-slate-100 rounded-full h-2">
          <div className="bg-blue-600 h-2 rounded-full transition-all duration-500" style={{ width: `${pct}%` }} />
        </div>
        <p className="text-xs text-slate-400">Dashboard will open automatically when complete</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center gap-4 py-20">
        <p className="text-red-600">{error}</p>
        <Link href="/batches" className="text-sm text-blue-600 hover:underline">← Back to workspace</Link>
      </div>
    );
  }

  if (!summary || imageList.length === 0) {
    return (
      <div className="flex flex-col items-center gap-4 py-20 text-slate-500">
        <p>No images found in this batch.</p>
        <Link href="/batches" className="text-sm text-blue-600 hover:underline">← Back to workspace</Link>
      </div>
    );
  }

  const intensity = getIntensity(summary.epg);
  const ic = INTENSITY_CONFIG[intensity];
  const currentRow = imageList[currentIndex];
  const totalReview = imageList.reduce((a, r) => a + r.review_count, 0);

  return (
    <div className="flex flex-col bg-slate-50">

      {/* ── 1. Top toolbar ───────────────────────────────────────────────── */}
      <div className="flex items-center gap-4 px-6 py-4 bg-white border-b border-gray-200 flex-shrink-0">
        <Link
          href="/batches"
          className="text-xs text-slate-400 hover:text-slate-600 transition-colors flex-shrink-0"
        >
          ← Back
        </Link>

        <h1 className="text-[28px] font-bold text-slate-900 tracking-tight truncate flex-1 min-w-0 leading-tight">
          <InlineEdit
            value={summary.batch_name}
            onSave={async (name) => {
              const updated = await renameBatch(batchId, name);
              setSummary((prev) => prev ? { ...prev, batch_name: updated.name } : prev);
            }}
            displayClassName="text-[28px] font-bold text-slate-900 tracking-tight leading-tight"
            inputClassName="text-[28px] font-bold text-slate-900 tracking-tight leading-tight bg-transparent border-b-2 border-blue-500 focus:outline-none w-full"
          />
        </h1>

        {/* Threshold control */}
        <div className="flex items-center gap-2 flex-shrink-0">
          <label className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider whitespace-nowrap">
            Threshold
          </label>
          <div className="flex items-center border border-gray-200 rounded-lg overflow-hidden focus-within:ring-2 focus-within:ring-blue-600 bg-white">
            <input
              type="number"
              min={0}
              max={100}
              value={thresholdInput}
              onChange={(e) => setThresholdInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleThresholdApply()}
              className="w-16 px-2 py-1.5 text-sm text-slate-900 focus:outline-none tabular-nums"
            />
            <span className="pr-2 text-sm text-slate-400">%</span>
          </div>
          <button
            onClick={handleThresholdApply}
            className="px-3 py-1.5 text-xs font-semibold bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
          >
            Apply
          </button>
        </div>

        {/* Download CSV */}
        <button
          onClick={handleDownload}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors flex-shrink-0"
        >
          <Download size={13} strokeWidth={2} />
          CSV
        </button>
      </div>

      {/* ── 1b. Overlap check status ─────────────────────────────────────── */}
      {dedupState === "running" && (
        <div className="flex items-center gap-3 px-6 py-3 bg-blue-50 border-b border-blue-200 flex-shrink-0">
          <Loader2 size={18} strokeWidth={2.25} className="text-blue-600 animate-spin flex-shrink-0" />
          <div className="text-sm text-blue-900">
            <p className="font-semibold">Checking for overlapping images…</p>
            <p className="text-xs text-blue-800/80">
              The same egg can appear in two overlapping photos. Total eggs and EPG may still go down
              until this finishes (usually 1–3 min; longer for big batches). You can keep reviewing meanwhile.
            </p>
          </div>
        </div>
      )}
      {dedupState === "finished" && (
        <div className="flex items-center gap-3 px-6 py-3 bg-green-50 border-b border-green-200 flex-shrink-0">
          <CheckCircle2 size={18} strokeWidth={2.25} className="text-green-600 flex-shrink-0" />
          <div className="text-sm text-green-900 flex-1">
            <p className="font-semibold">Overlap check finished — Total eggs and EPG are final.</p>
            <p className="text-xs text-green-800/80 tabular-nums">
              {summary.duplicate_count} duplicate egg{summary.duplicate_count !== 1 ? "s" : ""} excluded
              across {summary.overlap_pairs ?? 0} overlapping image pair{summary.overlap_pairs !== 1 ? "s" : ""}.
            </p>
          </div>
          <button
            onClick={() => setDedupState("idle")}
            title="Dismiss"
            className="p-1 rounded-md text-green-700 hover:bg-green-100 transition-colors flex-shrink-0"
          >
            <X size={16} strokeWidth={2} />
          </button>
        </div>
      )}
      {dedupState === "error" && (
        <div className="flex items-center gap-3 px-6 py-3 bg-red-50 border-b border-red-200 flex-shrink-0">
          <AlertTriangle size={18} strokeWidth={2.25} className="text-red-600 flex-shrink-0" />
          <div className="text-sm text-red-900 flex-1 min-w-0">
            <p className="font-semibold">Overlap check failed — eggs seen in two overlapping images may be counted twice.</p>
            <p className="text-xs text-red-800/80 truncate">{dedupError}</p>
          </div>
          <button
            onClick={() => watchDedup(true)}
            className="px-3 py-1.5 text-xs font-semibold bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors flex-shrink-0"
          >
            Try again
          </button>
        </div>
      )}

      {/* ── 2. Dashboard header ──────────────────────────────────────────── */}
      <div className="px-6 py-5 bg-white border-b border-gray-200 flex-shrink-0 space-y-4">

        {/* Metric cards — neutral tint, accent blue numbers */}
        <div className="grid grid-cols-4 gap-4">
          {([
            { label: "Total Eggs",      Icon: Hash,         value: summary.total_eggs.toLocaleString(),  pending: true  },
            { label: "EPG (×24)",       Icon: Calculator,   value: summary.epg.toLocaleString(),         pending: true  },
            { label: "Images Reviewed", Icon: CheckCircle2, value: summary.image_count.toLocaleString(), pending: false },
            {
              label: "Avg Confidence",
              Icon:  TrendingUp,
              value: summary.avg_confidence !== null
                ? `${Math.round(summary.avg_confidence * 100)}%`
                : "—",
              pending: false,
            },
          ] as const).map(({ label, Icon, value, pending }) => (
            <div key={label} className="border border-gray-200 rounded-xl px-5 py-4 bg-slate-50">
              <div className="flex items-center gap-1.5 mb-1">
                <Icon size={13} strokeWidth={1.75} className="text-slate-400" />
                <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">{label}</p>
                {pending && dedupState === "running" && (
                  <span
                    title="May still go down while the overlap check runs"
                    className="ml-auto inline-flex items-center gap-1 text-[10px] font-medium text-blue-700 bg-blue-50 border border-blue-200 px-1.5 py-px rounded-full"
                  >
                    <Loader2 size={10} strokeWidth={2.5} className="animate-spin" />
                    updating
                  </span>
                )}
              </div>
              <p className="text-[32px] font-bold text-blue-600 tabular-nums leading-none">
                {value}
              </p>
            </div>
          ))}
        </div>

        {/* Infection intensity banner */}
        <div className={`border rounded-xl px-6 py-4 ${ic.bg} ${ic.border}`}>
          <div className="flex items-center justify-between gap-6 flex-wrap">

            {/* Left: label + EPG + needs-review count */}
            <div>
              <p className={`text-xs font-semibold uppercase tracking-wide opacity-70 mb-1 ${ic.text}`}>
                Infection Intensity
              </p>
              <p className={`text-xl font-bold flex items-center gap-2 ${ic.text}`}>
                {ic.emoji} {ic.label} Infection
              </p>
              <p className={`text-sm mt-1 opacity-80 ${ic.text} tabular-nums`}>
                EPG = {summary.epg.toLocaleString()} eggs per gram
                {totalReview > 0 && (
                  <span className="ml-3 text-amber-600 font-semibold opacity-100">
                    · ⚠ {totalReview} box{totalReview !== 1 ? "es" : ""} need review
                  </span>
                )}
              </p>
              {summary.failed_images > 0 && (
                <p className="text-sm mt-1 font-semibold text-red-700 tabular-nums">
                  ⚠ {summary.failed_images} image{summary.failed_images !== 1 ? "s" : ""} could not be
                  processed by the detector. Look for &quot;Could not process&quot; in the image list.
                </p>
              )}
              <p className={`text-xs mt-1 opacity-70 ${ic.text} tabular-nums`}>
                {dedupState === "running"
                  ? "⏳ Overlap check in progress…"
                  : dedupState === "error" || summary.overlap_pairs === null
                  ? "⚠ Overlap check not completed"
                  : `✓ Overlap check done · ${summary.duplicate_count} duplicate egg${summary.duplicate_count !== 1 ? "s" : ""} excluded across ${summary.overlap_pairs} overlapping image pair${summary.overlap_pairs !== 1 ? "s" : ""}`}
              </p>
            </div>

            {/* Right: color-scale needle bar */}
            <div className="flex flex-col gap-1.5 min-w-[200px]">
              <div className={`flex justify-between text-xs font-medium opacity-70 ${ic.text}`}>
                <span>0</span>
                <span>2,000</span>
                <span>4,000+</span>
              </div>
              <div className="relative h-3 rounded-full bg-white/60 overflow-hidden border border-white/40">
                <div className="absolute inset-y-0 left-0 w-1/2 bg-green-500/30 rounded-l-full" />
                <div className="absolute inset-y-0 left-1/2 w-1/4 bg-amber-400/30" />
                <div className="absolute inset-y-0 left-3/4 right-0 bg-red-500/30 rounded-r-full" />
                <div
                  className={`absolute top-0 h-full w-1 rounded-full ${ic.bar} shadow`}
                  style={{
                    left: `${Math.min(Math.round((summary.epg / 6000) * 100), 98)}%`,
                    transform: "translateX(-50%)",
                  }}
                />
              </div>
              <div className={`flex justify-between text-xs opacity-60 ${ic.text}`}>
                <span>🟢 Light</span>
                <span>🟡 Mod</span>
                <span>🔴 Heavy</span>
              </div>
            </div>
          </div>

          {/* Severity legend row */}
          <div className={`mt-3 pt-3 border-t ${ic.border} grid grid-cols-3 gap-2 text-xs ${ic.text}`}>
            <div className={`flex items-center gap-1.5 px-2 py-1 rounded-md ${intensity === "light" ? "bg-white/50 font-bold ring-1 ring-green-400" : "opacity-60"}`}>
              🟢 Light &lt; 2,000
            </div>
            <div className={`flex items-center gap-1.5 px-2 py-1 rounded-md ${intensity === "moderate" ? "bg-white/50 font-bold ring-1 ring-amber-400" : "opacity-60"}`}>
              🟡 Moderate 2,000–3,999
            </div>
            <div className={`flex items-center gap-1.5 px-2 py-1 rounded-md ${intensity === "heavy" ? "bg-white/50 font-bold ring-1 ring-red-400" : "opacity-60"}`}>
              🔴 Heavy ≥ 4,000
            </div>
          </div>
        </div>
      </div>

      {/* ── 3. Review body ───────────────────────────────────────────────── */}
      <div className="flex">

        {/* Image list panel — sticks at the top of the viewport, independently scrollable */}
        <div className="w-64 flex-shrink-0 bg-white border-r border-gray-200 flex flex-col sticky top-0 self-start h-screen overflow-hidden">
          <ImageListPanel
            images={imageList}
            currentIndex={currentIndex}
            onSelect={(idx) => { setCurrentIndex(idx); setSelectedId(null); setAddMode(false); }}
          />
        </div>

        {/* Annotator area — grows with the image; page scrolls */}
        <div className="flex-1 flex flex-col min-w-0">

          {/* Per-image top bar — sticks at the top of the image column */}
          <div className="sticky top-0 z-[60] flex items-center justify-between px-4 py-2 bg-white border-b-2 border-gray-200 shadow-sm gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <p className="text-sm font-medium text-slate-900 truncate">
                {currentRow?.filename ?? ""}
              </p>
              <span className="text-xs text-slate-400 flex-shrink-0 tabular-nums">
                {currentIndex + 1}/{imageList.length}
              </span>
              <span className="text-[10px] font-medium bg-blue-50 text-blue-600 px-2 py-0.5 rounded-full flex-shrink-0 tabular-nums">
                {currentRow?.egg_count ?? 0} egg{(currentRow?.egg_count ?? 0) !== 1 ? "s" : ""}
              </span>
              {currentRow?.needs_review && (
                <span className="text-[10px] font-medium bg-amber-50 text-amber-600 border border-amber-200 px-2 py-0.5 rounded-full flex-shrink-0 tabular-nums">
                  ⚠ {currentRow.review_count}
                </span>
              )}
              {(currentRow?.duplicate_count ?? 0) > 0 && (
                <span className="text-[10px] font-medium bg-slate-100 text-slate-500 border border-slate-200 px-2 py-0.5 rounded-full flex-shrink-0 tabular-nums">
                  {currentRow!.duplicate_count} dup
                </span>
              )}
            </div>

            <div className="flex items-center gap-2 flex-shrink-0">
              {/* Mark as reviewed toggle */}
              <button
                onClick={handleToggleReviewed}
                className={`text-xs px-3 py-1.5 rounded-lg font-medium transition-colors ${
                  currentRow?.is_checked
                    ? "bg-blue-600 text-white hover:bg-blue-700"
                    : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                }`}
                title={currentRow?.is_checked ? "Mark as unreviewed" : "Mark as reviewed"}
              >
                {currentRow?.is_checked ? "✓ Reviewed" : "Mark reviewed"}
              </button>

              <div className="w-px h-5 bg-gray-200" />

              <button
                onClick={() => { setCurrentIndex((i) => Math.max(0, i - 1)); setSelectedId(null); }}
                disabled={currentIndex === 0}
                className="text-xs px-3 py-1.5 bg-slate-100 text-slate-600 rounded-lg hover:bg-slate-200 disabled:opacity-40 transition-colors"
              >
                ← Prev
              </button>
              <button
                onClick={() => { setCurrentIndex((i) => Math.min(imageList.length - 1, i + 1)); setSelectedId(null); }}
                disabled={currentIndex >= imageList.length - 1}
                className="text-xs px-3 py-1.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-40 transition-colors"
              >
                Next →
              </button>
              <button
                onClick={() => { setAddMode((m) => !m); setSelectedId(null); }}
                className={`inline-flex items-center gap-1 text-xs px-3 py-1.5 rounded-lg font-medium transition-colors ${
                  addMode
                    ? "bg-blue-100 text-blue-700 ring-1 ring-blue-400"
                    : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                }`}
              >
                {addMode ? "✏ Add mode ON" : <><Plus size={13} strokeWidth={2.5} />Add box</>}
              </button>
            </div>
          </div>

          {/* Overlap strip — which other images share area with this one */}
          {overlaps.length > 0 && (
            <div className="flex items-center gap-2 px-4 py-2 bg-violet-50 border-b border-violet-200 text-xs flex-wrap">
              <span className="font-semibold text-violet-700">⧉ Overlaps with</span>
              {overlaps.map((o) => (
                <button
                  key={o.image_id}
                  onClick={() => setCompare({ partner: o, focus: null })}
                  title={o.status === "rejected" ? "Marked as different area" : "Compare side by side"}
                  className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border font-medium max-w-[260px] ${
                    o.status === "rejected"
                      ? "bg-slate-50 border-slate-300 text-slate-400 line-through hover:bg-slate-100"
                      : o.strength === "weak" && o.status === "auto"
                      ? "bg-amber-50 border-amber-300 text-amber-700 hover:bg-amber-100"
                      : "bg-white border-violet-300 text-violet-700 hover:bg-violet-100"
                  }`}
                >
                  <span className="truncate">{o.filename}</span>
                  {o.status === "confirmed" && <span className="text-green-600 no-underline">✓</span>}
                  {o.status === "auto" && o.strength === "weak" && <span>⚠</span>}
                </button>
              ))}
              {overlaps.some((o) => o.status === "auto" && o.strength === "weak") && (
                <span className="text-amber-700">⚠ weak match</span>
              )}
              <label className="ml-auto flex items-center gap-1.5 text-violet-700 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={showOverlaps}
                  onChange={(e) => setShowOverlaps(e.target.checked)}
                  className="accent-violet-600"
                />
                Shade shared areas
              </label>
            </div>
          )}

          {/* Image area — no height/overflow constraint; page is what scrolls */}
          <div className="bg-gray-50">
            {imageDetail ? (
              <ImageAnnotator
                imageSrc={`/uploads/${batchId}/${currentRow?.filename}`}
                knownUnreadable={currentRow?.inference_failed}
                detections={imageDetail.detections}
                threshold={threshold}
                addMode={addMode}
                selectedId={selectedId}
                onSelectDetection={setSelectedId}
                onAddDetection={handleAdd}
                onDeleteDetection={handleDelete}
                overlapRegions={
                  showOverlaps
                    ? overlaps
                        .filter((o) => o.status !== "rejected")
                        .map((o) => ({ key: o.image_id, points: o.region_here, label: `also in ${o.filename}` }))
                    : []
                }
              />
            ) : (
              <div className="flex items-center justify-center min-h-48">
                <div className="h-8 w-8 rounded-full border-4 border-blue-600 border-t-transparent animate-spin" />
              </div>
            )}
          </div>

          {/* Selected-box action bar — sticks to bottom so it's always reachable */}
          {selectedDet && (
            <div className="sticky bottom-0 z-10 flex items-center justify-between px-4 py-3 bg-white border-t border-gray-200">
              <div className="flex items-center gap-3">
                <div className={`w-3 h-3 rounded-sm flex-shrink-0 ${
                  selectedDet.is_duplicate
                    ? "bg-slate-400"
                    : isNeedsReview(selectedDet)
                    ? "bg-amber-400"
                    : selectedDet.source === "manual"
                    ? "bg-blue-500"
                    : "bg-green-500"
                }`} />
                <div>
                  <p className="text-xs font-semibold text-slate-900">
                    {selectedDet.source === "manual" ? "Manual annotation" : "YOLO detection"}
                  </p>
                  <p className="text-xs text-slate-400 tabular-nums">
                    Confidence: {fmtConf(selectedDet.confidence)}
                    {isNeedsReview(selectedDet) && " · below threshold — needs review"}
                    {selectedDet.is_confirmed && " · confirmed"}
                  </p>
                  {selectedDet.is_duplicate && (
                    <p className="text-xs text-slate-500">
                      Duplicate — already counted in {selectedDet.duplicate_of_filename ?? "an overlapping image"} · not counted here
                    </p>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2">
                {selectedDet.is_duplicate && selectedDet.duplicate_of_image_id != null && (
                  <button
                    onClick={() => openCompareForDuplicate(selectedDet)}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-violet-600 text-white text-xs font-semibold rounded-lg hover:bg-violet-700 transition-colors"
                  >
                    ⧉ Compare
                  </button>
                )}
                {selectedDet.is_duplicate && (
                  <button
                    onClick={() => handleNotDuplicate(selectedDet.id)}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-700 text-white text-xs font-semibold rounded-lg hover:bg-slate-800 transition-colors"
                  >
                    Not a duplicate
                  </button>
                )}
                {isNeedsReview(selectedDet) && (
                  <button
                    onClick={() => handleConfirm(selectedDet.id)}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-green-600 text-white text-xs font-semibold rounded-lg hover:bg-green-700 transition-colors"
                  >
                    ✓ Confirm egg
                  </button>
                )}
                <button
                  onClick={() => handleDelete(selectedDet.id)}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-red-50 text-red-700 text-xs font-semibold rounded-lg hover:bg-red-100 transition-colors border border-red-200"
                >
                  ✕ Remove
                </button>
              </div>
            </div>
          )}

          {/* Hint bar */}
          {!selectedDet && (
            <div className="sticky bottom-0 z-10 px-4 py-2 bg-slate-50 border-t border-gray-200 text-xs text-slate-400">
              {addMode
                ? "Draw a box on the canvas to add a detection (100% confidence)"
                : "Click a bounding box to select it · toggle + Add box to draw new ones"}
            </div>
          )}
        </div>
      </div>

      {/* Side-by-side overlap compare */}
      {compare && imageDetail && (
        <OverlapCompare
          batchId={batchId}
          current={imageDetail}
          partner={compare.partner}
          threshold={threshold}
          focusDetectionId={compare.focus}
          onClose={() => setCompare(null)}
          onOpenPartner={openImageById}
          onDecided={refreshKeepingImage}
        />
      )}
    </div>
  );
}
