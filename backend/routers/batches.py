import io
import shutil
import zipfile
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from sqlalchemy.orm import Session

from database import get_db
from models import Batch, Detection, Image
from scoring import (
    is_accepted as _is_accepted,
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
    ImageListRow,
    SummaryImageRow,
    SummaryOut,
    ThresholdUpdate,
)

router = APIRouter(prefix="/api/batches", tags=["batches"])

STORAGE_ROOT = Path(__file__).parent.parent / "storage"
ALLOWED_EXTS = {".jpg", ".jpeg", ".png"}
MAX_FILE_SIZE = 50 * 1024 * 1024  # 50 MB per image
MAX_IMAGES = 200


# ── helpers ──────────────────────────────────────────────────────────────────

def _upload_dir(batch_id: int) -> Path:
    return STORAGE_ROOT / "uploads" / str(batch_id)


def _safe_extract_zip(zip_bytes: bytes, dest_dir: Path) -> list[Path]:
    extracted = []
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        for member in zf.infolist():
            safe_name = Path(member.filename).name
            if not safe_name:
                continue
            if Path(safe_name).suffix.lower() not in ALLOWED_EXTS:
                continue
            if member.file_size > MAX_FILE_SIZE:
                continue
            target = (dest_dir / safe_name).resolve()
            if not str(target).startswith(str(dest_dir.resolve())):
                continue  # path traversal guard
            with zf.open(member) as src, open(target, "wb") as dst:
                dst.write(src.read())
            extracted.append(target)
    return extracted


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
    positive_count = 0

    for img in images:
        idets = by_image.get(img.id, [])
        accepted = [d for d in idets if _is_accepted(d, threshold)]
        egg_count = len(accepted)
        review_count = sum(1 for d in idets if _needs_review(d, threshold))
        total_eggs += egg_count
        if egg_count > 0:
            positive_count += 1
        rows.append(SummaryImageRow(
            image_id=img.id,
            filename=img.filename,
            egg_count=egg_count,
            review_count=review_count,
            needs_review=review_count > 0,
        ))

    # needs-review first (by review_count desc), then by egg_count desc
    rows.sort(key=lambda r: (r.needs_review, r.review_count, r.egg_count), reverse=True)

    # Average confidence: all non-deleted YOLO detections (by_image already excludes deleted)
    yolo_confs = [
        d.confidence
        for dets in by_image.values()
        for d in dets
        if d.source == "yolo" and d.confidence is not None
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


@router.post("/{batch_id}/upload", response_model=BatchOut)
async def upload_images(
    batch_id: int,
    files: list[UploadFile] = File(...),
    db: Session = Depends(get_db),
):
    batch = _get_batch_or_404(batch_id, db)
    if batch.status not in ("pending",):
        raise HTTPException(status_code=400, detail="Batch already has uploads")

    dest_dir = _upload_dir(batch_id)
    dest_dir.mkdir(parents=True, exist_ok=True)
    saved_paths: list[Path] = []

    for upload in files:
        data = await upload.read()
        ext = Path(upload.filename or "").suffix.lower()

        if ext == ".zip":
            extracted = _safe_extract_zip(data, dest_dir)
            saved_paths.extend(extracted)
        elif ext in ALLOWED_EXTS:
            if len(data) > MAX_FILE_SIZE:
                continue
            safe_name = Path(upload.filename).name
            target = dest_dir / safe_name
            target.write_bytes(data)
            saved_paths.append(target)

    if not saved_paths:
        raise HTTPException(status_code=400, detail="No valid image files found")

    # Cap at MAX_IMAGES
    saved_paths = saved_paths[:MAX_IMAGES]

    for path in saved_paths:
        rel = f"uploads/{batch_id}/{path.name}"
        db.add(Image(batch_id=batch_id, filename=path.name, filepath=rel))

    batch.image_count = len(saved_paths)
    batch.status = "pending"
    db.commit()
    db.refresh(batch)
    return batch


@router.get("/{batch_id}/images", response_model=list[ImageListRow])
def list_images(batch_id: int, db: Session = Depends(get_db)):
    batch = _get_batch_or_404(batch_id, db)
    threshold = _threshold_of(batch)
    images = db.query(Image).filter(Image.batch_id == batch_id).all()
    by_image = _detections_by_image(batch_id, db)

    rows: list[ImageListRow] = []
    for img in images:
        idets = by_image.get(img.id, [])
        egg_count = sum(1 for d in idets if _is_accepted(d, threshold))
        review_count = sum(1 for d in idets if _needs_review(d, threshold))
        rows.append(ImageListRow(
            id=img.id,
            batch_id=img.batch_id,
            filename=img.filename,
            filepath=img.filepath,
            egg_count=egg_count,
            review_count=review_count,
            needs_review=review_count > 0,
            is_checked=img.is_checked,
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
