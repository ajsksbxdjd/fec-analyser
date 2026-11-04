from datetime import datetime
from typing import Optional
from pydantic import BaseModel, ConfigDict, Field


class DetectionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    image_id: int
    x_center: float
    y_center: float
    width: float
    height: float
    confidence: Optional[float]
    source: str
    is_deleted: bool
    is_confirmed: bool
    is_duplicate: bool = False
    duplicate_of_id: Optional[int] = None
    duplicate_of_filename: Optional[str] = None   # image holding the box that keeps counting
    duplicate_of_image_id: Optional[int] = None
    keep_override: bool = False


class DetectionCreate(BaseModel):
    x_center: float
    y_center: float
    width: float
    height: float


class ImageOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    batch_id: int
    filename: str
    filepath: str
    is_checked: bool
    created_at: datetime


class ImageListRow(BaseModel):
    """Row for the dashboard image list — accepted egg count + review state."""
    id: int
    batch_id: int
    filename: str
    filepath: str
    egg_count: int       # accepted detections (conf >= threshold OR confirmed OR manual)
    review_count: int    # sub-threshold, unconfirmed YOLO boxes awaiting a decision
    needs_review: bool
    is_checked: bool
    duplicate_count: int = 0  # boxes hidden because the egg is counted in an overlapping image
    overlap_count: int = 0    # how many other images overlap this one     # True when a human has explicitly marked this image as reviewed


class ImageDetail(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    batch_id: int
    filename: str
    filepath: str
    is_checked: bool
    created_at: datetime
    confidence_threshold: float   # the parent batch's threshold, for box coloring
    detections: list[DetectionOut] = []


class BatchCreate(BaseModel):
    name: str


class BatchRename(BaseModel):
    name: str


class ThresholdUpdate(BaseModel):
    confidence_threshold: float = Field(ge=0.0, le=1.0)


class BatchOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    created_at: datetime
    status: str
    image_count: int
    processed_count: int
    confidence_threshold: float


class BatchListRow(BatchOut):
    """BatchOut plus live aggregate metrics for the Recent-analyses table."""
    total_eggs: int
    epg: int
    severity: str


class BatchDetail(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    created_at: datetime
    status: str
    image_count: int
    processed_count: int
    confidence_threshold: float
    images: list[ImageOut] = []


class ProgressOut(BaseModel):
    batch_id: int
    status: str
    image_count: int
    processed_count: int
    elapsed_seconds: Optional[float] = None  # set once inference finishes


class SummaryImageRow(BaseModel):
    image_id: int
    filename: str
    egg_count: int
    review_count: int
    needs_review: bool
    duplicate_count: int = 0


class SummaryOut(BaseModel):
    batch_id: int
    batch_name: str
    total_eggs: int
    epg: int
    image_count: int
    positive_count: int            # images with >= 1 accepted egg
    avg_confidence: Optional[float] # mean confidence of non-deleted YOLO dets; None if none
    severity: str
    threshold: float
    duplicate_count: int = 0             # boxes excluded as cross-image duplicates
    overlap_pairs: Optional[int] = None  # confirmed overlapping image pairs; None = dedup never ran
    images: list[SummaryImageRow]


class OverlapPartnerOut(BaseModel):
    """Another image that overlaps this one, with where the shared area is."""
    overlap_id: int
    image_id: int
    filename: str
    inliers: int                       # overlap strength (RANSAC inlier matches)
    strength: str                      # "strong" | "weak" — weak ones deserve a human look
    status: str                        # "auto" | "confirmed" | "rejected"
    region_here: list[list[float]]     # partner's frame outline in THIS image, normalized [x, y] 0-1
    region_there: list[list[float]]    # this image's frame outline in the PARTNER, normalized
    matches: list[list[float]] = []    # evidence: [x_here, y_here, x_there, y_there] normalized


class OverlapDecision(BaseModel):
    status: str = Field(pattern="^(auto|confirmed|rejected)$")


class OverlapDecisionOut(BaseModel):
    overlap_id: int
    status: str
    duplicates_found: int


class DedupOut(BaseModel):
    batch_id: int
    total_images: int
    pairs_checked: int
    candidate_pairs: int
    overlap_pairs: int
    duplicates_found: int
    elapsed_seconds: float
