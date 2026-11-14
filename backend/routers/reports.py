import csv
import io
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from database import get_db
from models import Batch, Detection, Image
from scoring import is_accepted, is_duplicate, needs_review, severity, threshold_of

router = APIRouter(prefix="/api/batches", tags=["reports"])

# WHO hookworm intensity classes (from scoring.severity) -> report label.
# Plain ASCII so the labels read correctly in any spreadsheet app.
INTENSITY_LABELS = {
    "Light":    "Light (EPG below 2,000)",
    "Moderate": "Moderate (EPG 2,000 to 3,999)",
    "Heavy":    "Heavy (EPG 4,000 and above)",
}


@router.get("/{batch_id}/report.csv")
def download_report(batch_id: int, db: Session = Depends(get_db)):
    batch = db.query(Batch).filter(Batch.id == batch_id).first()
    if not batch:
        raise HTTPException(status_code=404, detail="Batch not found")

    threshold = threshold_of(batch.confidence_threshold)
    images = (
        db.query(Image)
        .filter(Image.batch_id == batch_id)
        .order_by(Image.id)
        .all()
    )

    # One pass over the images: per-image rows + batch totals
    rows = []
    total_eggs = 0
    total_dups = 0
    total_review = 0
    total_failed = 0
    for img in images:
        dets = (
            db.query(Detection)
            .filter(Detection.image_id == img.id)
            .all()
        )
        count = sum(1 for d in dets if is_accepted(d, threshold))
        review = sum(1 for d in dets if needs_review(d, threshold))
        dups = sum(1 for d in dets if is_duplicate(d))
        total_eggs += count
        total_dups += dups
        total_review += review
        if img.inference_failed:
            total_failed += 1
        rows.append([img.id, img.filename, count, review if review else "", dups if dups else ""])

    epg = total_eggs * 24
    intensity = severity(epg)
    problems = []
    if total_review:
        problems.append(f"{total_review} detections still need review (not counted)")
    if total_failed:
        problems.append(f"{total_failed} images could not be processed")
    review_status = "; ".join(problems) if problems else "Complete"

    output = io.StringIO()
    writer = csv.writer(output)

    # 1. Result — what the lab reads first
    writer.writerow(["FEC ANALYSER REPORT"])
    writer.writerow(["Sample", batch.name])
    writer.writerow(["EPG (eggs per gram)", epg])
    writer.writerow(["Infection Intensity (WHO)", INTENSITY_LABELS[intensity]])
    writer.writerow(["Review Status", review_status])
    writer.writerow([])

    # 2. How it was calculated
    writer.writerow(["Total Eggs Counted", total_eggs])
    writer.writerow(["EPG Formula", "Total eggs x 24 (Kato-Katz, 41.7 mg template)"])
    writer.writerow(["Duplicates Excluded (overlapping images)", total_dups])
    writer.writerow(["Images Analysed", len(images)])
    writer.writerow(["Images Not Processed", total_failed])
    writer.writerow(["Confidence Threshold", f"{round(threshold * 100)}%"])
    writer.writerow(["Generated", datetime.now().strftime("%Y-%m-%d %H:%M")])
    writer.writerow([])

    # 3. Per-image detail
    writer.writerow(["Image ID", "Filename", "Egg Count", "Needs Review", "Duplicates Excluded"])
    writer.writerows(rows)

    # BOM so Excel opens the file as UTF-8 (sample / file names may be non-ASCII)
    content = "\ufeff" + output.getvalue()
    filename = f"batch_{batch_id}_{batch.name.replace(' ', '_')}.csv"
    return StreamingResponse(
        iter([content]),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
