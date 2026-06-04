"""
Shared detection-acceptance and severity helpers.

Used by both the batches router (live list / summary / threshold update)
and the reports router (CSV download) to guarantee consistent counts.
"""

DEFAULT_THRESHOLD = 0.70


def is_accepted(det, threshold: float) -> bool:
    """
    True when this non-deleted detection counts as an egg.

    Accepted when:
      - manually drawn (source == "manual")      → always, confidence 1.0
      - researcher confirmed it (is_confirmed)   → always, regardless of conf
      - YOLO box with conf >= threshold          → auto-accepted
    """
    if det.is_deleted:
        return False
    if det.source == "manual" or det.is_confirmed:
        return True
    return det.confidence is not None and det.confidence >= threshold


def needs_review(det, threshold: float) -> bool:
    """
    True when this detection is a sub-threshold YOLO box awaiting a decision.
    It does not count as an egg until confirmed (or removed).
    """
    return (
        not det.is_deleted
        and det.source == "yolo"
        and not det.is_confirmed
        and (det.confidence is None or det.confidence < threshold)
    )


def severity(epg: int) -> str:
    """WHO hookworm intensity classification."""
    if epg < 2000:
        return "Light"
    if epg < 4000:
        return "Moderate"
    return "Heavy"


def threshold_of(value) -> float:
    """Return the stored threshold, falling back to the default when None."""
    return value if value is not None else DEFAULT_THRESHOLD
