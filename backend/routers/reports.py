import csv
import io
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from database import get_db
from models import Batch, Detection, Image
from scoring import is_accepted, needs_review, severity, threshold_of

router = APIRouter(prefix="/api/batches", tags=["reports"])


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

    output = io.StringIO()
    writer = csv.writer(output)

    writer.writerow(["Batch Name", batch.name])
    writer.writerow(["Generated", datetime.utcnow().strftime("%Y-%m-%d %H:%M UTC")])
    writer.writerow(["Confidence Threshold", f"{round(threshold * 100)}%"])
    writer.writerow([])
    writer.writerow(["Image ID", "Filename", "Egg Count", "Needs Review"])

    total_eggs = 0
    for img in images:
        dets = (
            db.query(Detection)
            .filter(Detection.image_id == img.id)
            .all()
        )
        count = sum(1 for d in dets if is_accepted(d, threshold))
        review = sum(1 for d in dets if needs_review(d, threshold))
        total_eggs += count
        writer.writerow([img.id, img.filename, count, review if review else ""])

    epg = total_eggs * 24
    intensity = severity(epg)
    intensity_labels = {
        "Light":    "Light (EPG < 2,000)",
        "Moderate": "Moderate (EPG 2,000–3,999)",
        "Heavy":    "Heavy (EPG ≥ 4,000)",
    }

    writer.writerow([])
    writer.writerow(["Total Eggs", total_eggs])
    writer.writerow(["EPG (x24)", epg])
    writer.writerow(["Infection Intensity", intensity_labels[intensity]])

    output.seek(0)
    filename = f"batch_{batch_id}_{batch.name.replace(' ', '_')}.csv"
    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
