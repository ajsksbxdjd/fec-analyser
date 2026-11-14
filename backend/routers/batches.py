import io
import shutil
import zipfile
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from PIL import Image as PILImage
from sqlalchemy.orm import Session

from database import get_db
from models import Batch, Detection, Image, ImageOverlap
from scoring import (
    is_accepted as _is_accepted,
    is_duplicate as _is_duplicate,
    needs_review as _needs_review,
    severity as _severity,
    threshold_of as _threshold_of_val,
)
from schemas import (
    BatchCreate,
    BatchDetail,
    BatchListRow,
    BatchOut,
    BatchRename,
    DedupJobOut,
    ImageListRow,
    SummaryImageRow,
    SummaryOut,
    ThresholdUpdate,
    UploadOut,
)

router = APIRouter(prefix="/api/batches", tags=["batches"])

STORAGE_ROOT = Path(__file__).parent.parent / "storage"
ALLOWED_EXTS = {".jpg", ".jpeg", ".png"}
MAX_FILE_SIZE = 50 * 1024 * 1024  # 50 MB per image
MAX_IMAGES = 500  # per batch; keep in sync with MAX_IMAGES in frontend/components/BatchUpload.tsx


# ── helpers ──────────────────────────────────────────────────────────────────

def _upload_dir(batch_id: int) -> Path:
    return STORAGE_ROOT / "uploads" / str(batch_id)


# Reasons shown to the user for files that were not added to the batch
SKIP_TYPE = "unsupported file type"
SKIP_SIZE = "larger than 50 MB"
SKIP_CORRUPT = "corrupted or unreadable image"
SKIP_UNSAFE = "unsafe path in ZIP"
SKIP_BAD_ZIP = "corrupted or unreadable ZIP file"

# OS clutter that ZIP tools add (macOS resource forks, Windows thumbnails).
# Ignored without a warning — they are not files the user chose to upload.
_ZIP_JUNK_DIRS = {"__MACOSX"}
_ZIP_JUNK_FILES = {".ds_store", "thumbs.db", "desktop.ini"}


def _is_readable_image(path: Path) -> bool:
    """
    True when Pillow can fully decode the file. verify() checks the structure;
    it can't be followed by load() on the same object, so the file is reopened
    and load() decodes every pixel — that catches truncated / half-written files.
    """
    try:
        with PILImage.open(path) as im:
            im.verify()
        with PILImage.open(path) as im:
            im.load()
        return True
    except Exception:
        return False


def _is_zip_junk(member_name: str) -> bool:
    parts = Path(member_name.replace("\\", "/")).parts
    return (
        any(p in _ZIP_JUNK_DIRS for p in parts)
        or Path(member_name).name.lower() in _ZIP_JUNK_FILES
        or Path(member_name).name.startswith("._")
    )


def _is_unsafe_zip_path(member_name: str) -> bool:
    """Absolute paths or '..' segments — a ZIP trying to write outside its folder."""
    name = member_name.replace("\\", "/")
    return name.startswith("/") or (len(name) > 1 and name[1] == ":") or ".." in name.split("/")


def _unique_path(dest_dir: Path, name: str, taken: set[str]) -> Path:
    """
    A path in dest_dir that no other image of this batch uses: 'IMG_0001.jpg',
    else 'IMG_0001_2.jpg', 'IMG_0001_3.jpg', ...

    Two files with the same name (same name in two ZIP folders, or in two
    chunked tunnel requests) would otherwise overwrite each other on disk while
    both get an Image row — one image inferred twice, its eggs counted twice.

    `taken` holds lowercase names already used by this batch (DB rows + this
    request); the chosen name is added to it. The on-disk check also catches
    files left from earlier uploads. Lowercase because Windows paths ignore case.
    """
    stem, suffix = Path(name).stem, Path(name).suffix
    candidate, n = name, 1
    while candidate.lower() in taken or (dest_dir / candidate).exists():
        n += 1
        candidate = f"{stem}_{n}{suffix}"
    taken.add(candidate.lower())
    return dest_dir / candidate


def _inside_dir(path: Path, dest_dir: Path) -> bool:
    """Path traversal guard: the final file must sit directly in dest_dir."""
    return path.resolve().parent == dest_dir.resolve()


def _safe_extract_zip(zip_bytes: bytes, dest_dir: Path, taken: set[str]) -> tuple[list[Path], list[dict]]:
    """
    Extract the images of a ZIP into dest_dir (folders flattened; clashing
    names get _2, _3, ... via _unique_path).
    Returns (extracted image paths, skipped files as {name, reason}).
    """
    extracted: list[Path] = []
    skipped: list[dict] = []
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        for member in zf.infolist():
            if member.is_dir() or _is_zip_junk(member.filename):
                continue
            safe_name = Path(member.filename.replace("\\", "/")).name
            if not safe_name:
                continue
            if _is_unsafe_zip_path(member.filename):
                skipped.append({"name": member.filename, "reason": SKIP_UNSAFE})
                continue
            if Path(safe_name).suffix.lower() not in ALLOWED_EXTS:
                skipped.append({"name": member.filename, "reason": SKIP_TYPE})
                continue
            if member.file_size > MAX_FILE_SIZE:
                skipped.append({"name": member.filename, "reason": SKIP_SIZE})
                continue
            target = _unique_path(dest_dir, safe_name, taken)
            if not _inside_dir(target, dest_dir):
                taken.discard(target.name.lower())
                skipped.append({"name": member.filename, "reason": SKIP_UNSAFE})  # path traversal guard
                continue
            if target.name != safe_name:
                print(f"[upload] name clash: {member.filename} saved as {target.name}")
            with zf.open(member) as src, open(target, "wb") as dst:
                dst.write(src.read())
            if not _is_readable_image(target):
                target.unlink(missing_ok=True)
                taken.discard(target.name.lower())
                skipped.append({"name": member.filename, "reason": SKIP_CORRUPT})
                continue
            extracted.append(target)
    return extracted, skipped


def _skipped_summary(skipped: list[dict], limit: int = 5) -> str:
    """'a.pdf (unsupported file type); b.jpg (...)' — first `limit`, then 'and N more'."""
    shown = "; ".join(f"{s['name']} ({s['reason']})" for s in skipped[:limit])
    more = len(skipped) - limit
    return shown + (f"; and {more} more" if more > 0 else "")


def _get_batch_or_404(batch_id: int, db: Session) -> Batch:
    batch = db.query(Batch).filter(Batch.id == batch_id).first()
    if not batch:
        raise HTTPException(status_code=404, detail="Batch not found")
    return batch


def _threshold_of(batch: Batch) -> float:
    return _threshold_of_val(batch.confidence_threshold)


def _detections_by_image(batch_id: int, db: Session) -> dict[int, list[Detection]]:
    """All non-deleted detections for a batch, grouped by image_id (one query)."""
    dets = (
        db.query(Detection)
        .join(Image, Detection.image_id == Image.id)
        .filter(Image.batch_id == batch_id, Detection.is_deleted == False)  # noqa: E712
        .all()
    )
    grouped: dict[int, list[Detection]] = {}
    for d in dets:
        grouped.setdefault(d.image_id, []).append(d)
    return grouped


def _build_summary(batch: Batch, db: Session) -> SummaryOut:
    threshold = _threshold_of(batch)
    images = db.query(Image).filter(Image.batch_id == batch.id).all()
    by_image = _detections_by_image(batch.id, db)

    rows: list[SummaryImageRow] = []
    total_eggs = 0
    total_dups = 0
    positive_count = 0

    for img in images:
        idets = by_image.get(img.id, [])
        accepted = [d for d in idets if _is_accepted(d, threshold)]
        egg_count = len(accepted)
        review_count = sum(1 for d in idets if _needs_review(d, threshold))
        dup_count = sum(1 for d in idets if _is_duplicate(d))
        total_eggs += egg_count
        total_dups += dup_count
        if egg_count > 0:
            positive_count += 1
        rows.append(SummaryImageRow(
            image_id=img.id,
            filename=img.filename,
            egg_count=egg_count,
            review_count=review_count,
            needs_review=review_count > 0,
            duplicate_count=dup_count,
        ))

    # needs-review first (by review_count desc), then by egg_count desc
    rows.sort(key=lambda r: (r.needs_review, r.review_count, r.egg_count), reverse=True)

    # Average confidence: all non-deleted, non-duplicate YOLO detections
    # (by_image already excludes deleted)
    yolo_confs = [
        d.confidence
        for dets in by_image.values()
        for d in dets
        if d.source == "yolo" and d.confidence is not None and not _is_duplicate(d)
    ]
    avg_conf = round(sum(yolo_confs) / len(yolo_confs), 4) if yolo_confs else None

    epg = total_eggs * 24

    return SummaryOut(
        batch_id=batch.id,
        batch_name=batch.name,
        total_eggs=total_eggs,
        epg=epg,
        image_count=len(images),
        positive_count=positive_count,
        avg_confidence=avg_conf,
        severity=_severity(epg),
        threshold=threshold,
        duplicate_count=total_dups,
        overlap_pairs=batch.overlap_pairs,
        failed_images=sum(1 for img in images if img.inference_failed),
        images=rows,
    )


# ── routes ───────────────────────────────────────────────────────────────────

@router.post("", response_model=BatchOut, status_code=201)
def create_batch(payload: BatchCreate, db: Session = Depends(get_db)):
    batch = Batch(name=payload.name.strip())
    db.add(batch)
    db.commit()
    db.refresh(batch)
    _upload_dir(batch.id).mkdir(parents=True, exist_ok=True)
    return batch


@router.get("", response_model=list[BatchListRow])
def list_batches(db: Session = Depends(get_db)):
    batches = db.query(Batch).order_by(Batch.created_at.desc()).all()
    rows: list[BatchListRow] = []
    for b in batches:
        threshold = _threshold_of(b)
        by_image = _detections_by_image(b.id, db)
        total = sum(
            1
            for dets in by_image.values()
            for d in dets
            if _is_accepted(d, threshold)
        )
        epg = total * 24
        rows.append(BatchListRow(
            id=b.id,
            name=b.name,
            created_at=b.created_at,
            status=b.status,
            image_count=b.image_count,
            processed_count=b.processed_count,
            confidence_threshold=threshold,
            total_eggs=total,
            epg=epg,
            severity=_severity(epg),
        ))
    return rows


@router.get("/{batch_id}", response_model=BatchDetail)
def get_batch(batch_id: int, db: Session = Depends(get_db)):
    return _get_batch_or_404(batch_id, db)


@router.delete("/{batch_id}", status_code=204)
def delete_batch(batch_id: int, db: Session = Depends(get_db)):
    batch = _get_batch_or_404(batch_id, db)
    upload_dir = _upload_dir(batch_id)
    db.delete(batch)
    db.commit()
    if upload_dir.exists():
        shutil.rmtree(upload_dir)


@router.patch("/{batch_id}", response_model=BatchOut)
def rename_batch(batch_id: int, payload: BatchRename, db: Session = Depends(get_db)):
    """Rename a batch. Returns 400 if the new name is blank."""
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Batch name cannot be blank")
    batch = _get_batch_or_404(batch_id, db)
    batch.name = name
    db.commit()
    db.refresh(batch)
    return batch


@router.post("/{batch_id}/upload", response_model=UploadOut)
async def upload_images(
    batch_id: int,
    files: list[UploadFile] = File(...),
    db: Session = Depends(get_db),
):
    batch = _get_batch_or_404(batch_id, db)
    if batch.status not in ("pending",):
        raise HTTPException(status_code=400, detail="Batch already has uploads")
    # Uploads may arrive in several requests (the browser splits large uploads
    # into chunks when the app is reached through a tunnel / proxy).
    existing = db.query(Image).filter(Image.batch_id == batch_id).count()
    room = MAX_IMAGES - existing
    if room <= 0:
        raise HTTPException(status_code=400, detail=f"Batch already has the maximum of {MAX_IMAGES} images")

    dest_dir = _upload_dir(batch_id)
    dest_dir.mkdir(parents=True, exist_ok=True)
    saved_paths: list[Path] = []
    skipped: list[dict] = []   # every file NOT added, with the reason — returned to the user
    # Names this batch already uses (earlier uploads / chunks), so a repeated
    # name gets a new file instead of overwriting one that already has a row
    taken = {
        fn.lower()
        for (fn,) in db.query(Image.filename).filter(Image.batch_id == batch_id).all()
    }

    for upload in files:
        data = await upload.read()
        name = Path(upload.filename or "").name or "(unnamed file)"
        ext = Path(name).suffix.lower()

        if ext == ".zip":
            try:
                extracted, zip_skipped = _safe_extract_zip(data, dest_dir, taken)
            except zipfile.BadZipFile:
                skipped.append({"name": name, "reason": SKIP_BAD_ZIP})
                continue
            saved_paths.extend(extracted)
            skipped.extend({"name": f"{name}/{s['name']}", "reason": s["reason"]} for s in zip_skipped)
        elif ext not in ALLOWED_EXTS:
            skipped.append({"name": name, "reason": SKIP_TYPE})
        elif len(data) > MAX_FILE_SIZE:
            skipped.append({"name": name, "reason": SKIP_SIZE})
        else:
            target = _unique_path(dest_dir, name, taken)
            if not _inside_dir(target, dest_dir):
                taken.discard(target.name.lower())
                skipped.append({"name": name, "reason": SKIP_UNSAFE})
                continue
            if target.name != name:
                print(f"[upload] name clash: {name} saved as {target.name}")
            target.write_bytes(data)
            if not _is_readable_image(target):
                target.unlink(missing_ok=True)
                taken.discard(target.name.lower())
                skipped.append({"name": name, "reason": SKIP_CORRUPT})
                continue
            saved_paths.append(target)

    if skipped:
        print(f"[upload] batch {batch_id}: skipped {len(skipped)} file(s): {_skipped_summary(skipped, 20)}")

    # Large uploads through a tunnel arrive as several requests. Only fail when
    # the batch would end up with no images at all; otherwise a request whose
    # files were all skipped just reports them.
    if not saved_paths and existing == 0:
        detail = "No valid image files found"
        if skipped:
            detail += ". Skipped: " + _skipped_summary(skipped)
        raise HTTPException(status_code=400, detail=detail)

    # Max MAX_IMAGES for the whole batch (across chunked requests). Refuse
    # instead of silently dropping the extra images, so the count is never
    # quietly wrong.
    if len(saved_paths) > room:
        for path in saved_paths:
            path.unlink(missing_ok=True)
        raise HTTPException(
            status_code=400,
            detail=f"Too many images: a batch can have at most {MAX_IMAGES} "
                   f"(this upload has {existing + len(saved_paths)}). Split it into smaller batches.",
        )

    for path in saved_paths:
        rel = f"uploads/{batch_id}/{path.name}"
        db.add(Image(batch_id=batch_id, filename=path.name, filepath=rel))

    batch.image_count = existing + len(saved_paths)
    batch.status = "pending"
    db.commit()
    db.refresh(batch)
    return UploadOut(**BatchOut.model_validate(batch).model_dump(), skipped=skipped)


@router.get("/{batch_id}/images", response_model=list[ImageListRow])
def list_images(batch_id: int, db: Session = Depends(get_db)):
    batch = _get_batch_or_404(batch_id, db)
    threshold = _threshold_of(batch)
    images = db.query(Image).filter(Image.batch_id == batch_id).all()
    by_image = _detections_by_image(batch_id, db)
    overlap_counts: dict[int, int] = {}
    for a_id, b_id in (
        db.query(ImageOverlap.image_a_id, ImageOverlap.image_b_id)
        .filter(ImageOverlap.batch_id == batch_id, ImageOverlap.status != "rejected")
        .all()
    ):
        overlap_counts[a_id] = overlap_counts.get(a_id, 0) + 1
        overlap_counts[b_id] = overlap_counts.get(b_id, 0) + 1

    rows: list[ImageListRow] = []
    for img in images:
        idets = by_image.get(img.id, [])
        egg_count = sum(1 for d in idets if _is_accepted(d, threshold))
        review_count = sum(1 for d in idets if _needs_review(d, threshold))
        dup_count = sum(1 for d in idets if _is_duplicate(d))
        rows.append(ImageListRow(
            id=img.id,
            batch_id=img.batch_id,
            filename=img.filename,
            filepath=img.filepath,
            egg_count=egg_count,
            review_count=review_count,
            needs_review=review_count > 0,
            is_checked=img.is_checked,
            duplicate_count=dup_count,
            overlap_count=overlap_counts.get(img.id, 0),
            inference_failed=bool(img.inference_failed),
        ))

    # Three-section sort:
    #   0 = Needs review (urgent)
    #   1 = Auto-Accepted (!needs_review, !is_checked)
    #   2 = Reviewed (!needs_review, is_checked)
    # Within each section: most eggs first
    def _section(r: ImageListRow) -> int:
        if r.needs_review:
            return 0
        return 2 if r.is_checked else 1

    rows.sort(key=lambda r: (_section(r), -r.egg_count))
    return rows


@router.patch("/{batch_id}/threshold", response_model=SummaryOut)
def update_threshold(batch_id: int, payload: ThresholdUpdate, db: Session = Depends(get_db)):
    batch = _get_batch_or_404(batch_id, db)
    batch.confidence_threshold = payload.confidence_threshold
    db.commit()
    db.refresh(batch)
    return _build_summary(batch, db)


@router.get("/{batch_id}/summary", response_model=SummaryOut)
def get_summary(batch_id: int, db: Session = Depends(get_db)):
    batch = _get_batch_or_404(batch_id, db)
    return _build_summary(batch, db)


@router.post("/{batch_id}/dedup", response_model=DedupJobOut, status_code=202)
def run_dedup(batch_id: int, db: Session = Depends(get_db)):
    """
    Start (re)running overlap detection + cross-image dedup for a batch in the
    background; poll GET /{batch_id}/dedup for the result.

    Runs automatically after inference; run it again after adding / removing
    boxes or after marking a box "not a duplicate".
    """
    batch = _get_batch_or_404(batch_id, db)
    if batch.status == "processing":
        raise HTTPException(status_code=400, detail="Inference still running")
    from dedup import DedupAlreadyRunning, dedup_job_status, start_dedup_job
    try:
        start_dedup_job(batch_id)
    except DedupAlreadyRunning as e:
        raise HTTPException(status_code=409, detail=str(e)) from e
    return DedupJobOut(**dedup_job_status(batch_id))


@router.get("/{batch_id}/dedup", response_model=DedupJobOut)
def get_dedup_status(batch_id: int, db: Session = Depends(get_db)):
    """State of the last background dedup job: idle | running | done | error."""
    _get_batch_or_404(batch_id, db)
    from dedup import dedup_job_status
    return DedupJobOut(**dedup_job_status(batch_id))
