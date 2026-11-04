import type {
  Batch,
  DedupResult,
  BatchDetail,
  BatchListRow,
  DetectionCreate,
  Detection,
  Image,
  ImageDetail,
  ImageListRow,
  OverlapPartner,
  OverlapStatus,
  Progress,
  Summary,
} from "./types";

// JSON API calls go through the Next.js rewrite proxy (/api/* → :8000/api/*)
const BASE = "/api";

// File uploads go DIRECTLY to the FastAPI backend to bypass the Next.js
// 10 MB body-size limit on the dev proxy. XHR also gives us upload progress.
//
// Use window.location.hostname so this works whether the app is accessed via
// localhost OR a LAN IP like 192.168.100.42 — the backend is always on the
// same machine as the frontend, just on port 8000.
const DIRECT_BACKEND =
  process.env.NEXT_PUBLIC_API_URL ||
  (typeof window !== "undefined"
    ? `http://${window.location.hostname}:8000`
    : "http://localhost:8000");

// ── helpers ───────────────────────────────────────────────────────────────────

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

// ── Batches ───────────────────────────────────────────────────────────────────

export const createBatch = (name: string) =>
  apiFetch<Batch>("/batches", {
    method: "POST",
    body: JSON.stringify({ name }),
  });

/** Returns BatchListRow[] — includes live EPG / severity for each batch. */
export const listBatches = () => apiFetch<BatchListRow[]>("/batches");

export const getBatch = (id: number) => apiFetch<BatchDetail>(`/batches/${id}`);

export const deleteBatch = (id: number) =>
  fetch(`${BASE}/batches/${id}`, { method: "DELETE" });

/** Rename a batch — returns the updated Batch. */
export const renameBatch = (id: number, name: string) =>
  apiFetch<Batch>(`/batches/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ name }),
  });

/**
 * Upload files directly to the FastAPI backend using XHR so we get:
 *  - No Next.js body-size limit (10 MB cap bypassed entirely)
 *  - Real upload progress events via xhr.upload.onprogress
 */
export function uploadImagesWithProgress(
  batchId: number,
  files: File[],
  onProgress: (pct: number) => void,
): Promise<Batch> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    files.forEach((f) => form.append("files", f));

    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${DIRECT_BACKEND}/api/batches/${batchId}/upload`);

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        onProgress(Math.round((e.loaded / e.total) * 100));
      }
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText) as Batch);
        } catch {
          reject(new Error("Invalid JSON response from server"));
        }
      } else {
        reject(new Error(`${xhr.status}: ${xhr.responseText || xhr.statusText}`));
      }
    };

    xhr.onerror = () => reject(new Error("Upload failed — check backend is running on port 8000"));
    xhr.ontimeout = () => reject(new Error("Upload timed out"));
    xhr.timeout = 0; // No timeout so large ZIPs can complete
    xhr.send(form);
  });
}

export const runInference = (batchId: number) =>
  apiFetch<Progress>(`/batches/${batchId}/run-inference`, { method: "POST" });

export const getBatchStatus = (batchId: number) =>
  apiFetch<Progress>(`/batches/${batchId}/status`);

/** Returns ImageListRow[] sorted needs-review-first, then most-eggs-first. */
export const listImages = (batchId: number) =>
  apiFetch<ImageListRow[]>(`/batches/${batchId}/images`);

export const getBatchSummary = (batchId: number) =>
  apiFetch<Summary>(`/batches/${batchId}/summary`);

/** Update the confidence threshold — returns the recomputed Summary. */
export const updateThreshold = (batchId: number, threshold: number) =>
  apiFetch<Summary>(`/batches/${batchId}/threshold`, {
    method: "PATCH",
    body: JSON.stringify({ confidence_threshold: threshold }),
  });

/** Re-run overlap detection + cross-image dedup for the batch. */
// Goes DIRECT to the backend: dedup on ~200 images takes ~40-60 s, longer than
// the Next.js dev proxy's 30 s timeout (which returns a bare 500).
export const runDedup = async (batchId: number): Promise<DedupResult> => {
  const res = await fetch(`${DIRECT_BACKEND}/api/batches/${batchId}/dedup`, { method: "POST" });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`${res.status}: ${text}`);
  }
  return res.json() as Promise<DedupResult>;
};

export const downloadReport = async (batchId: number): Promise<Blob> => {
  const res = await fetch(`${BASE}/batches/${batchId}/report.csv`);
  if (!res.ok) throw new Error(`${res.status}: ${res.statusText}`);
  return res.blob();
};

// ── Images ────────────────────────────────────────────────────────────────────

export const getImage = (imageId: number) =>
  apiFetch<ImageDetail>(`/images/${imageId}`);

/** Images overlapping this one, strongest first, with the shared-area outlines. */
export const getImageOverlaps = (imageId: number) =>
  apiFetch<OverlapPartner[]>(`/images/${imageId}/overlaps`);

/** Reviewer decision on an overlap; duplicate flags are recomputed at once. */
export const decideOverlap = (overlapId: number, status: OverlapStatus) =>
  apiFetch<{ overlap_id: number; status: OverlapStatus; duplicates_found: number }>(
    `/overlaps/${overlapId}`,
    { method: "PATCH", body: JSON.stringify({ status }) },
  );

/** Toggle the human-reviewed flag on an image. Returns the updated ImageOut. */
export const toggleImageCheck = (imageId: number) =>
  apiFetch<Image>(`/images/${imageId}/check`, { method: "PATCH" });

// ── Detections ────────────────────────────────────────────────────────────────

export const addDetection = (imageId: number, payload: DetectionCreate) =>
  apiFetch<Detection>(`/images/${imageId}/detections`, {
    method: "POST",
    body: JSON.stringify(payload),
  });

/** Confirm a sub-threshold YOLO box — it counts as an egg from now on. */
export const confirmDetection = (detectionId: number) =>
  apiFetch<Detection>(`/detections/${detectionId}/confirm`, { method: "PATCH" });

/** Override: this box is not a duplicate — count it again. */
export const markNotDuplicate = (detectionId: number) =>
  apiFetch<Detection>(`/detections/${detectionId}/not-duplicate`, { method: "PATCH" });

export const deleteDetection = (detectionId: number) =>
  fetch(`${BASE}/detections/${detectionId}`, { method: "DELETE" });
