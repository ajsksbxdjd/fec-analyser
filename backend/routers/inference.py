import time

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from sqlalchemy.orm import Session

from database import SessionLocal, get_db
from models import Batch, Detection, Image
from schemas import ProgressOut

router = APIRouter(prefix="/api/batches", tags=["inference"])


def _run_batch_inference(batch_id: int) -> None:
    """
    Background task — creates its own DB session (never reuse the request session).

    Images are processed in chunks matching BATCH_SIZE so the GPU does one
    forward pass per chunk. DB is committed once per chunk, not per image.
    """
    db: Session = SessionLocal()
    try:
        from ml.detector import run_batch_inference, BATCH_SIZE
        from pathlib import Path

        batch = db.query(Batch).filter(Batch.id == batch_id).first()
        if not batch:
            return

        images = db.query(Image).filter(Image.batch_id == batch_id).all()
        STORAGE_ROOT = Path(__file__).parent.parent / "storage"

        # ── Start wall-clock timer ────────────────────────────────────────────
        t0 = time.perf_counter()

        for chunk_start in range(0, len(images), BATCH_SIZE):
            chunk = images[chunk_start : chunk_start + BATCH_SIZE]
            chunk_paths = [str(STORAGE_ROOT / img.filepath) for img in chunk]

            try:
                chunk_results = run_batch_inference(chunk_paths)

                for img, detections in zip(chunk, chunk_results):
                    # Remove previous YOLO detections so re-runs don't duplicate
                    db.query(Detection).filter(
                        Detection.image_id == img.id,
                        Detection.source == "yolo",
                    ).delete()

                    for d in detections:
                        db.add(Detection(
                            image_id=img.id,
                            x_center=d["x_center"],
                            y_center=d["y_center"],
                            width=d["width"],
                            height=d["height"],
                            confidence=d["confidence"],
                            source="yolo",
                            is_deleted=False,
                        ))

                    batch.processed_count += 1

                # One commit per chunk — much less DB lock overhead than per image
                db.commit()

            except Exception as e:
                print(f"[inference] Error on chunk {chunk_start}–{chunk_start + len(chunk)}: {e}")
                db.rollback()
                # Mark images in this chunk as processed so the count stays accurate
                batch.processed_count += len(chunk)
                db.commit()
                continue

        # ── Stop timer, persist, log ──────────────────────────────────────────
        elapsed = time.perf_counter() - t0
        n = len(images)
        per_img = f"{elapsed / n:.2f}s/image" if n else "—"
        print(f"[inference] Inference done: {n} images in {elapsed:.1f}s ({per_img})")

        batch.status = "done"
        batch.elapsed_seconds = round(elapsed, 2)
        db.commit()

    except Exception as e:
        print(f"[inference] Fatal error for batch {batch_id}: {e}")
        db.rollback()
        try:
            batch = db.query(Batch).filter(Batch.id == batch_id).first()
            if batch:
                batch.status = "pending"
                db.commit()
        except Exception:
            pass
    finally:
        db.close()


@router.post("/{batch_id}/run-inference", response_model=ProgressOut)
def run_inference_endpoint(
    batch_id: int,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    batch = db.query(Batch).filter(Batch.id == batch_id).first()
    if not batch:
        raise HTTPException(status_code=404, detail="Batch not found")
    if batch.image_count == 0:
        raise HTTPException(status_code=400, detail="No images uploaded to this batch")
    if batch.status == "processing":
        raise HTTPException(status_code=400, detail="Inference already running")

    batch.status = "processing"
    batch.processed_count = 0
    db.commit()
    db.refresh(batch)

    background_tasks.add_task(_run_batch_inference, batch_id)

    return ProgressOut(
        batch_id=batch_id,
        status=batch.status,
        image_count=batch.image_count,
        processed_count=batch.processed_count,
        elapsed_seconds=None,
    )


@router.get("/{batch_id}/status", response_model=ProgressOut)
def get_status(batch_id: int, db: Session = Depends(get_db)):
    batch = db.query(Batch).filter(Batch.id == batch_id).first()
    if not batch:
        raise HTTPException(status_code=404, detail="Batch not found")
    return ProgressOut(
        batch_id=batch_id,
        status=batch.status,
        image_count=batch.image_count,
        processed_count=batch.processed_count,
        elapsed_seconds=batch.elapsed_seconds,
    )
