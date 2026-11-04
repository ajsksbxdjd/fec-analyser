import json

import numpy as np
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import or_
from sqlalchemy.orm import Session

from database import get_db
from models import Batch, Detection, Image, ImageOverlap
from schemas import DetectionOut, ImageDetail, ImageOut, OverlapPartnerOut
from scoring import threshold_of

# Overlaps with fewer RANSAC inliers than this are shown as "weak" (check them)
STRONG_OVERLAP_INLIERS = 50

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
        detections=_detections_out(img, db),
    )


def _detections_out(img: Image, db: Session) -> list[DetectionOut]:
    """DetectionOut list, with the filename of the image each duplicate points at."""
    dup_targets = {d.duplicate_of_id for d in img.detections if d.is_duplicate and d.duplicate_of_id}
    target_files: dict[int, tuple[int, str]] = {}
    if dup_targets:
        rows = (
            db.query(Detection.id, Image.id, Image.filename)
            .join(Image, Detection.image_id == Image.id)
            .filter(Detection.id.in_(dup_targets))
            .all()
        )
        target_files = {det_id: (img_id, fname) for det_id, img_id, fname in rows}

    out = []
    for d in img.detections:
        item = DetectionOut.model_validate(d)
        if d.is_duplicate and d.duplicate_of_id:
            target = target_files.get(d.duplicate_of_id)
            if target:
                item.duplicate_of_image_id, item.duplicate_of_filename = target
        out.append(item)
    return out


@router.patch("/{image_id}/check", response_model=ImageOut)
def toggle_check(image_id: int, db: Session = Depends(get_db)):
    """Toggle the human-reviewed flag on an image (is_checked True ↔ False)."""
    img = _get_image_or_404(image_id, db)
    img.is_checked = not img.is_checked
    db.commit()
    db.refresh(img)
    return img


def _frame_outline(h: np.ndarray, src_w: int, src_h: int, dst_w: int, dst_h: int) -> list[list[float]]:
    """Map the src image's 4 corners through h into dst, normalized to dst size."""
    corners = np.array([[0, 0, 1], [src_w, 0, 1], [src_w, src_h, 1], [0, src_h, 1]], dtype=np.float64).T
    mapped = h @ corners
    mapped = mapped[:2] / mapped[2]
    return [[round(float(x) / dst_w, 5), round(float(y) / dst_h, 5)] for x, y in mapped.T]


@router.get("/{image_id}/overlaps", response_model=list[OverlapPartnerOut])
def get_image_overlaps(image_id: int, db: Session = Depends(get_db)):
    """
    Images that overlap this one (found by the last dedup run), strongest first,
    with the outline of the shared area drawn in both images.
    """
    _get_image_or_404(image_id, db)
    rows = (
        db.query(ImageOverlap)
        .filter(or_(ImageOverlap.image_a_id == image_id, ImageOverlap.image_b_id == image_id))
        .order_by(ImageOverlap.inliers.desc())
        .all()
    )
    partner_ids = [r.image_b_id if r.image_a_id == image_id else r.image_a_id for r in rows]
    names = dict(db.query(Image.id, Image.filename).filter(Image.id.in_(partner_ids)).all()) if rows else {}

    out: list[OverlapPartnerOut] = []
    for r in rows:
        h_b_to_a = np.array(json.loads(r.h_b_to_a), dtype=np.float64).reshape(3, 3)
        try:
            h_a_to_b = np.linalg.inv(h_b_to_a)
        except np.linalg.LinAlgError:
            continue
        points = json.loads(r.match_points) if r.match_points else []  # [xa, ya, xb, yb]
        if r.image_a_id == image_id:   # this = a, partner = b
            partner = r.image_b_id
            here = _frame_outline(h_b_to_a, r.b_width, r.b_height, r.a_width, r.a_height)
            there = _frame_outline(h_a_to_b, r.a_width, r.a_height, r.b_width, r.b_height)
            matches = points
        else:                          # this = b, partner = a
            partner = r.image_a_id
            here = _frame_outline(h_a_to_b, r.a_width, r.a_height, r.b_width, r.b_height)
            there = _frame_outline(h_b_to_a, r.b_width, r.b_height, r.a_width, r.a_height)
            matches = [[xb, yb, xa, ya] for xa, ya, xb, yb in points]
        out.append(OverlapPartnerOut(
            overlap_id=r.id,
            image_id=partner,
            filename=names.get(partner, f"image {partner}"),
            inliers=r.inliers,
            strength="strong" if r.inliers >= STRONG_OVERLAP_INLIERS else "weak",
            status=r.status or "auto",
            region_here=here,
            region_there=there,
            matches=matches,
        ))
    return out
