from datetime import datetime
from sqlalchemy import Boolean, Column, DateTime, Float, ForeignKey, Integer, String
from sqlalchemy.orm import relationship
from database import Base


class Batch(Base):
    __tablename__ = "batches"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)
    status = Column(String, default="pending")  # pending | processing | done | reviewed
    image_count = Column(Integer, default=0)
    processed_count = Column(Integer, default=0)
    confidence_threshold = Column(Float, default=0.70)  # boxes below this need per-box review
    elapsed_seconds = Column(Float, nullable=True)      # wall-clock inference duration
    overlap_pairs = Column(Integer, nullable=True)      # confirmed overlapping image pairs (last dedup run)
    duplicates_found = Column(Integer, nullable=True)   # boxes flagged as cross-image duplicates (last dedup run)

    images = relationship("Image", back_populates="batch", cascade="all, delete-orphan")


class Image(Base):
    __tablename__ = "images"

    id = Column(Integer, primary_key=True, index=True)
    batch_id = Column(Integer, ForeignKey("batches.id", ondelete="CASCADE"), nullable=False)
    filename = Column(String, nullable=False)
    filepath = Column(String, nullable=False)  # relative: uploads/{batch_id}/{filename}
    is_checked = Column(Boolean, default=False)
    inference_failed = Column(Boolean, default=False)  # YOLO could not process this image (last run)
    created_at = Column(DateTime, default=datetime.utcnow)

    batch = relationship("Batch", back_populates="images")
    detections = relationship("Detection", back_populates="image", cascade="all, delete-orphan")


class ImageOverlap(Base):
    """Two images of a batch that show overlapping slide regions (from dedup)."""
    __tablename__ = "image_overlaps"

    id = Column(Integer, primary_key=True, index=True)
    batch_id = Column(Integer, ForeignKey("batches.id", ondelete="CASCADE"), nullable=False, index=True)
    image_a_id = Column(Integer, ForeignKey("images.id", ondelete="CASCADE"), nullable=False, index=True)
    image_b_id = Column(Integer, ForeignKey("images.id", ondelete="CASCADE"), nullable=False, index=True)
    inliers = Column(Integer, nullable=False)       # RANSAC inlier matches — overlap strength
    h_b_to_a = Column(String, nullable=False)       # JSON 3x3 homography: image-b px -> image-a px
    a_width = Column(Integer, nullable=False)
    a_height = Column(Integer, nullable=False)
    b_width = Column(Integer, nullable=False)
    b_height = Column(Integer, nullable=False)
    match_points = Column(String, nullable=True)    # JSON [[xa, ya, xb, yb], ...] normalized — evidence
    status = Column(String, default="auto")         # auto | confirmed | rejected (reviewer decision)


class Detection(Base):
    __tablename__ = "detections"

    id = Column(Integer, primary_key=True, index=True)
    image_id = Column(Integer, ForeignKey("images.id", ondelete="CASCADE"), nullable=False)
    x_center = Column(Float, nullable=False)  # normalized 0-1
    y_center = Column(Float, nullable=False)
    width = Column(Float, nullable=False)
    height = Column(Float, nullable=False)
    confidence = Column(Float, nullable=True)
    source = Column(String, default="yolo")  # yolo | manual
    is_deleted = Column(Boolean, default=False)
    is_confirmed = Column(Boolean, default=False)  # researcher confirmed a sub-threshold box
    is_duplicate = Column(Boolean, default=False)  # same egg already counted in an overlapping image
    duplicate_of_id = Column(Integer, nullable=True)  # Detection.id of the box that keeps counting
    keep_override = Column(Boolean, default=False)  # researcher said "not a duplicate" — dedup never flags it

    image = relationship("Image", back_populates="detections")
