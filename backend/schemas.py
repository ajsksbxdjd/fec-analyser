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
    is_checked: bool     # True when a human has explicitly marked this image as reviewed


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
    images: list[SummaryImageRow]
