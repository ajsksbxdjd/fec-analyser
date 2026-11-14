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
  SkippedFile,
  Summary,
  UploadResult,
} from "./types";

// JSON API calls go through the Next.js rewrite proxy (/api/* → :8000/api/*)
const BASE = "/api";

// File uploads go DIRECTLY to the FastAPI backend when the app is opened on
// this machine or the local network (localhost / LAN IP): fastest, one request.
//
// Through a tunnel (e.g. https://xyz.trycloudflare.com) port 8000 is not
// reachable, so uploads go through the same address as the page (the Next.js
// proxy) instead, split into chunks that fit the proxy / tunnel size limits.
function isLocalNetwork(): boolean {
  if (typeof window === "undefined") return true;
  const h = window.location.hostname;
  return (
    window.location.protocol === "http:" &&
    (h === "localhost" ||
      h === "127.0.0.1" ||
      /^10\./.test(h) ||
      /^192\.168\./.test(h) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(h))
  );
}

const DIRECT_BACKEND =
  process.env.NEXT_PUBLIC_API_URL ||
  (typeof window !== "undefined"
    ? `http://${window.location.hostname}:8000`
    : "http://localhost:8000");

// Per-request upload size through a tunnel (Cloudflare caps requests at 100 MB)
const TUNNEL_CHUNK_BYTES = 40 * 1024 * 1024;
const TUNNEL_MAX_FILE_BYTES = 95 * 1024 * 1024;

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

/** POST one group of files with XHR so we get upload progress events. */
function postFiles(
  url: string,
  files: File[],
  onLoaded: (loaded: number) => void,
): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    files.forEach((f) => form.append("files", f));

    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onLoaded(e.loaded);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const res = JSON.parse(xhr.responseText) as UploadResult;
          resolve({ ...res, skipped: res.skipped ?? [] });
        } catch {
          reject(new Error("Invalid JSON response from server"));
        }
      } else {
        // FastAPI errors are {"detail": "..."} — show just the message
        let message = xhr.responseText || xhr.statusText;
        try {
          const body = JSON.parse(xhr.responseText);
          if (typeof body?.detail === "string") message = body.detail;
        } catch { /* not JSON — keep the raw text */ }
        reject(new Error(message));
      }
    };
    xhr.onerror = () => reject(new Error("Upload failed — check the backend is running"));
    xhr.ontimeout = () => reject(new Error("Upload timed out"));
    xhr.timeout = 0; // No timeout so large ZIPs can complete
    xhr.send(form);
  });
}

/**
 * Upload images / ZIPs for a batch, reporting overall progress (0-100).
 *
 *  - On this machine / the LAN: one request straight to FastAPI on :8000
 *    (no Next.js body-size limit at all).
 *  - Through a tunnel: several requests through the page's own address, each
 *    under TUNNEL_CHUNK_BYTES; the backend appends them to the same batch.
 *
 * The result's `skipped` lists every file the backend did not add (wrong type,
 * too big, corrupted…), merged across all the requests.
 */
export async function uploadImagesWithProgress(
  batchId: number,
  files: File[],
  onProgress: (pct: number) => void,
): Promise<UploadResult> {
  if (isLocalNetwork()) {
    return postFiles(`${DIRECT_BACKEND}/api/batches/${batchId}/upload`, files, (loaded) => {
      const total = files.reduce((a, f) => a + f.size, 0) || 1;
      onProgress(Math.min(100, Math.round((loaded / total) * 100)));
    });
  }

  const tooBig = files.find((f) => f.size > TUNNEL_MAX_FILE_BYTES);
  if (tooBig) {
    throw new Error(
      `${tooBig.name} is larger than 95 MB, which can't go through the shared link. ` +
      "Split the ZIP into smaller ZIPs, or upload the images directly.",
    );
  }

  const chunks: File[][] = [];
  let cur: File[] = [];
  let curBytes = 0;
  for (const f of files) {
    if (cur.length && curBytes + f.size > TUNNEL_CHUNK_BYTES) {
      chunks.push(cur);
      cur = [];
      curBytes = 0;
    }
    cur.push(f);
    curBytes += f.size;
  }
  if (cur.length) chunks.push(cur);

  const total = files.reduce((a, f) => a + f.size, 0) || 1;
  let done = 0;
  let last: UploadResult | null = null;
  const skipped: SkippedFile[] = [];
  for (const chunk of chunks) {
    const chunkBytes = chunk.reduce((a, f) => a + f.size, 0);
    last = await postFiles(`${BASE}/batches/${batchId}/upload`, chunk, (loaded) => {
      onProgress(Math.min(100, Math.round(((done + Math.min(loaded, chunkBytes)) / total) * 100)));
    });
    skipped.push(...last.skipped);
    done += chunkBytes;
  }
  onProgress(100);
  return { ...last!, skipped };
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
interface DedupJob {
  state: "idle" | "running" | "done" | "error";
  result: DedupResult | null;
  error: string | null;
}

/** State of the batch's background dedup job (idle | running | done | error). */
export const getDedupStatus = (batchId: number) =>
  apiFetch<DedupJob>(`/batches/${batchId}/dedup`);

/** Poll until the batch's running dedup job finishes. */
export const waitForDedup = async (
  batchId: number,
  isCancelled: () => boolean = () => false,
): Promise<DedupResult | null> => {
  for (;;) {
    await new Promise((r) => setTimeout(r, 2000));
    if (isCancelled()) return null;
    const job = await getDedupStatus(batchId);
    if (job.state === "done" && job.result) return job.result;
    if (job.state === "error") throw new Error(job.error ?? "Dedup failed");
    if (job.state === "idle") throw new Error("Dedup job was lost (backend restarted?)");
  }
};

/**
 * Re-run overlap detection + dedup. The backend runs it as a background job
 * (it takes ~1-2 min on 200 images, longer than proxies / tunnels allow a
 * request to stay open), so this starts it and polls until it finishes.
 * If one is already running (e.g. the automatic one after YOLO), it waits for that.
 */
export const runDedup = async (
  batchId: number,
  isCancelled: () => boolean = () => false,
): Promise<DedupResult | null> => {
  const res = await fetch(`${BASE}/batches/${batchId}/dedup`, { method: "POST" });
  if (!res.ok && res.status !== 409) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`${res.status}: ${text}`);
  }
  return waitForDedup(batchId, isCancelled);
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
