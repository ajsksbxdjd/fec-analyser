from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from database import get_db
from models import ImageOverlap
from schemas import OverlapDecision, OverlapDecisionOut

router = APIRouter(prefix="/api/overlaps", tags=["overlaps"])


@router.patch("/{overlap_id}", response_model=OverlapDecisionOut)
def decide_overlap(overlap_id: int, payload: OverlapDecision, db: Session = Depends(get_db)):
    """
    Reviewer decision on a detected overlap:
      - "rejected"  → not really the same area; duplicates that came from it count again
      - "confirmed" → reviewer checked it, keep it
      - "auto"      → undo the decision

    Duplicate flags for the batch are recomputed immediately (no image
    re-matching needed), and the decision survives a full dedup re-run.
    """
    from dedup import DedupAlreadyRunning, set_overlap_status

    overlap = db.query(ImageOverlap).filter(ImageOverlap.id == overlap_id).first()
    if not overlap:
        raise HTTPException(status_code=404, detail="Overlap not found")
    try:
        return OverlapDecisionOut(**set_overlap_status(db, overlap, payload.status))
    except DedupAlreadyRunning as e:
        raise HTTPException(status_code=409, detail=str(e)) from e
