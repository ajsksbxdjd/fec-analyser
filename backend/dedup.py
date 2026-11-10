"""
Batch-level dedup: runs ml/overlap.py on a batch and stores the result in the DB.

Two stages:
  1. find overlaps (slow, ORB on every image pair) → image_overlaps rows, with
     the transform between the images and sampled feature matches as evidence;
  2. apply duplicates (fast, no image reading) → Detection.is_duplicate flags,
     using every stored overlap the reviewer has NOT rejected.

Stage 2 re-runs on its own when the reviewer confirms / rejects an overlap, so
their decision takes effect immediately. Decisions survive a full re-run.

Duplicates are never deleted. They are flagged (Detection.is_duplicate) and
point at the box they duplicate (Detection.duplicate_of_id), so they stop
counting toward the egg total / EPG but stay visible and reversible in the UI.
"""

import json
import threading
from pathlib import Path

from sqlalchemy.orm import Session

from models import Batch, Detection, Image, ImageOverlap

STORAGE_ROOT = Path(__file__).parent / "storage"

OVERLAP_STATUSES = ("auto", "confirmed", "rejected")

# Batches with a dedup currently running. A second run on the same batch would
# just compete for CPU and race the first one's writes, so it is refused.
_running: set[int] = set()
_running_lock = threading.Lock()


class DedupAlreadyRunning(Exception):
    pass


class _BatchGuard:
    def __init__(self, batch_id: int) -> None:
        self.batch_id = batch_id

    def __enter__(self):
        with _running_lock:
            if self.batch_id in _running:
                raise DedupAlreadyRunning(f"Dedup is already running for batch {self.batch_id}")
            _running.add(self.batch_id)

    def __exit__(self, *exc):
        with _running_lock:
            _running.discard(self.batch_id)


# Last background dedup job per batch: {"state": running|done|error, "result", "error"}
_jobs: dict[int, dict] = {}


def start_dedup_job(batch_id: int) -> None:
    """
    Start a full dedup in a background thread and return immediately.

    The dashboard polls dedup_job_status(). A request that waits ~1-2 min for
    the result gets cut off by proxies / tunnels (Next.js dev proxy: 30 s,
    Cloudflare: 100 s), so the button must not hold a request open.
    """
    with _running_lock:
        if batch_id in _running:
            raise DedupAlreadyRunning(f"Dedup is already running for batch {batch_id}")
        _running.add(batch_id)  # claimed here so a double click gets a 409 at once
        _jobs[batch_id] = {"state": "running", "result": None, "error": None}

    def work() -> None:
        from database import SessionLocal
        db = SessionLocal()
        try:
            result = _run_full(db, batch_id)
            _jobs[batch_id] = {"state": "done", "result": result, "error": None}
        except Exception as e:
            db.rollback()
            print(f"[dedup] background job failed for batch {batch_id}: {e}")
            _jobs[batch_id] = {"state": "error", "result": None, "error": str(e)}
        finally:
            db.close()
            with _running_lock:
                _running.discard(batch_id)

    threading.Thread(target=work, name=f"dedup-{batch_id}", daemon=True).start()


def dedup_job_status(batch_id: int) -> dict:
    with _running_lock:
        running = batch_id in _running
    job = _jobs.get(batch_id)
    if running:
        return {"state": "running", "result": None, "error": None}
    return job or {"state": "idle", "result": None, "error": None}


def run_dedup_for_batch(db: Session, batch_id: int) -> dict:
    """Find overlaps from the images, then recompute duplicate flags. Commits."""
    with _BatchGuard(batch_id):
        return _run_full(db, batch_id)


def set_overlap_status(db: Session, overlap: ImageOverlap, status: str) -> dict:
    """Record the reviewer's decision on one overlap and re-apply dedup. Commits."""
    if status not in OVERLAP_STATUSES:
        raise ValueError(f"status must be one of {OVERLAP_STATUSES}")
    with _BatchGuard(overlap.batch_id):
        overlap.status = status
        dups = _apply_duplicates(db, overlap.batch_id)
        db.commit()
        return {"overlap_id": overlap.id, "status": status, "duplicates_found": dups}


def _pair_key(a: int, b: int) -> tuple[int, int]:
    return (a, b) if a < b else (b, a)


def _run_full(db: Session, batch_id: int) -> dict:
    from ml.overlap import find_overlaps

    batch = db.query(Batch).filter(Batch.id == batch_id).first()
    if batch is None:
        raise ValueError(f"Batch {batch_id} not found")

    images = db.query(Image).filter(Image.batch_id == batch_id).order_by(Image.id).all()
    paths: list[str] = []
    path_image_ids: list[int] = []
    for img in images:
        path = STORAGE_ROOT / img.filepath
        if not path.exists():
            print(f"[dedup] skipping missing file {path}")
            continue
        paths.append(str(path))
        path_image_ids.append(img.id)

    # Slow image matching — no DB writes yet, so nothing is locked meanwhile
    stats, pairs = find_overlaps(paths, debug_dir=STORAGE_ROOT / "uploads" / str(batch_id))

    # Reviewer decisions from earlier runs survive a re-run
    old_rows = db.query(ImageOverlap).filter(ImageOverlap.batch_id == batch_id).all()
    previous = {
        _pair_key(r.image_a_id, r.image_b_id): r.status
        for r in old_rows
        if r.status and r.status != "auto"
    }

    # All writes happen AFTER the slow part, in one short transaction.
    for r in old_rows:
        db.delete(r)
    db.flush()
    for p in pairs:
        a_id, b_id = path_image_ids[p.i], path_image_ids[p.j]
        db.add(ImageOverlap(
            batch_id=batch_id,
            image_a_id=a_id,
            image_b_id=b_id,
            inliers=p.inliers,
            h_b_to_a=json.dumps(p.h_j_to_i),
            a_width=p.size_i[0], a_height=p.size_i[1],
            b_width=p.size_j[0], b_height=p.size_j[1],
            match_points=json.dumps(p.matches),
            status=previous.get(_pair_key(a_id, b_id), "auto"),
        ))
    db.flush()

    dups = _apply_duplicates(db, batch_id)
    db.commit()

    return {
        "batch_id": batch_id,
        "total_images": stats.total_images,
        "pairs_checked": stats.total_pairs_checked,
        "candidate_pairs": stats.candidate_pairs,
        "overlap_pairs": batch.overlap_pairs or 0,
        "duplicates_found": dups,
        "elapsed_seconds": stats.elapsed_seconds,
    }


def _apply_duplicates(db: Session, batch_id: int) -> int:
    """Recompute duplicate flags from stored, non-rejected overlaps. No commit."""
    from ml.overlap import BoxIn, OverlapPair, dedup_from_pairs

    batch = db.query(Batch).filter(Batch.id == batch_id).first()
    images = db.query(Image).filter(Image.batch_id == batch_id).order_by(Image.id).all()
    index = {img.id: n for n, img in enumerate(images)}

    rows = (
        db.query(ImageOverlap)
        .filter(ImageOverlap.batch_id == batch_id, ImageOverlap.status != "rejected")
        .all()
    )
    sizes: list[tuple[int, int]] = [(1, 1)] * len(images)
    pairs: list[OverlapPair] = []
    for r in rows:
        if r.image_a_id not in index or r.image_b_id not in index:
            continue
        i, j = index[r.image_a_id], index[r.image_b_id]
        sizes[i], sizes[j] = (r.a_width, r.a_height), (r.b_width, r.b_height)
        pairs.append(OverlapPair(
            i=i, j=j, inliers=r.inliers, h_j_to_i=json.loads(r.h_b_to_a),
            size_i=sizes[i], size_j=sizes[j],
        ))

    boxes_per_image: list[list[BoxIn]] = []
    by_id: dict[int, Detection] = {}
    for img in images:
        boxes: list[BoxIn] = []
        for d in img.detections:
            if d.is_deleted:
                continue
            by_id[d.id] = d
            human_backed = d.source == "manual" or bool(d.is_confirmed)
            boxes.append(BoxIn(
                key=d.id,
                x_center=d.x_center,
                y_center=d.y_center,
                width=d.width,
                height=d.height,
                # Human-drawn / confirmed boxes outrank any raw YOLO box
                score=(d.confidence or 0.0) + (1.0 if human_backed else 0.0),
                protected=bool(d.keep_override),
            ))
        boxes_per_image.append(boxes)

    matches = dedup_from_pairs(sizes, pairs, boxes_per_image)

    for d in by_id.values():
        d.is_duplicate = False
        d.duplicate_of_id = None
    for m in matches:
        det = by_id.get(m.duplicate_key)
        if det is not None:
            det.is_duplicate = True
            det.duplicate_of_id = m.kept_key

    if batch is not None:
        batch.overlap_pairs = len(pairs)
        batch.duplicates_found = len(matches)
    print(f"[dedup] batch {batch_id}: {len(pairs)} active overlaps, {len(matches)} duplicate boxes")
    return len(matches)
