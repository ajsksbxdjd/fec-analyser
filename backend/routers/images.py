from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from database import get_db
from models import Batch, Image
from schemas import DetectionOut, ImageDetail, ImageOut
from scoring import threshold_of

router = APIRouter(prefix="/api/images", tags=["images"])


def _get_image_or_404(image_id: int, db: Session) -> Image:
    img = db.query(Image).filter(Image.id == image_id).first()
    if not img:
        raise HTTPException(status_code=404, detail="Image not found")
    return img


@router.get("/{image_id}", response_model=ImageDetail)
def get_image(image_id: int, db: Session = Depends(get_db)):
    """
    Return an image with all its detections.

    Also includes the parent batch's confidence_threshold so the annotator
    can color boxes (green = accepted, amber = needs review, blue = manual)
    without a separate API call.
    """
    img = _get_image_or_404(image_id, db)
    batch = db.query(Batch).filter(Batch.id == img.batch_id).first()
    conf_threshold = threshold_of(batch.confidence_threshold if batch else None)

    return ImageDetail(
        id=img.id,
        batch_id=img.batch_id,
        filename=img.filename,
        filepath=img.filepath,
        is_checked=img.is_checked,
        created_at=img.created_at,
        confidence_threshold=conf_threshold,
        detections=[DetectionOut.model_validate(d) for d in img.detections],
    )


@router.patch("/{image_id}/check", response_model=ImageOut)
def toggle_check(image_id: int, db: Session = Depends(get_db)):
    """Toggle the human-reviewed flag on an image (is_checked True ↔ False)."""
    img = _get_image_or_404(image_id, db)
    img.is_checked = not img.is_checked
    db.commit()
    db.refresh(img)
    return img
