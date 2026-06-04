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

    images = relationship("Image", back_populates="batch", cascade="all, delete-orphan")


class Image(Base):
    __tablename__ = "images"

    id = Column(Integer, primary_key=True, index=True)
    batch_id = Column(Integer, ForeignKey("batches.id", ondelete="CASCADE"), nullable=False)
    filename = Column(String, nullable=False)
    filepath = Column(String, nullable=False)  # relative: uploads/{batch_id}/{filename}
    is_checked = Column(Boolean, default=False)
    created_at = Column(DateTime, default=datetime.utcnow)

    batch = relationship("Batch", back_populates="images")
    detections = relationship("Detection", back_populates="image", cascade="all, delete-orphan")


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

    image = relationship("Image", back_populates="detections")
