from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from database import get_db
from models import Detection, Image
from schemas import DetectionCreate, DetectionOut

router = APIRouter(prefix="/api", tags=["detections"])


@router.post("/images/{image_id}/detections", response_model=DetectionOut, status_code=201)
def add_detection(
    image_id: int,
    payload: DetectionCreate,
    db: Session = Depends(get_db),
):
    """
    Add a manual annotation box.

    Manual boxes are always 100% confidence and pre-confirmed — they count as
    eggs immediately without going through the per-box review queue.
    """
    img = db.query(Image).filter(Image.id == image_id).first()
    if not img:
        raise HTTPException(status_code=404, detail="Image not found")

    det = Detection(
        image_id=image_id,
        x_center=payload.x_center,
        y_center=payload.y_center,
        width=payload.width,
        height=payload.height,
        confidence=1.0,      # manual boxes are always 100%
        source="manual",
        is_deleted=False,
        is_confirmed=True,   # never needs review
    )
    db.add(det)
    db.commit()
    db.refresh(det)
    return det


@router.patch("/detections/{detection_id}/confirm", response_model=DetectionOut)
def confirm_detection(detection_id: int, db: Session = Depends(get_db)):
    """
    Confirm a sub-threshold YOLO box — researcher decides it is a real egg.
    Sets is_confirmed=True so the box counts toward the egg count / EPG.
    """
    det = db.query(Detection).filter(Detection.id == detection_id).first()
    if not det:
        raise HTTPException(status_code=404, detail="Detection not found")
    det.is_confirmed = True
    db.commit()
    db.refresh(det)
    return det


@router.delete("/detections/{detection_id}", status_code=204)
def delete_detection(detection_id: int, db: Session = Depends(get_db)):
    """Soft-delete a detection (false positive or rejected sub-threshold box)."""
    det = db.query(Detection).filter(Detection.id == detection_id).first()
    if not det:
        raise HTTPException(status_code=404, detail="Detection not found")
    det.is_deleted = True
    db.commit()
