export type BatchStatus = "pending" | "processing" | "done" | "reviewed";
export type DetectionSource = "yolo" | "manual";

export interface Detection {
  id: number;
  image_id: number;
  x_center: number;
  y_center: number;
  width: number;
  height: number;
  confidence: number | null;
  source: DetectionSource;
  is_deleted: boolean;
  is_confirmed: boolean;
}

export interface DetectionCreate {
  x_center: number;
  y_center: number;
  width: number;
  height: number;
}

/** Raw image ORM row (no computed fields). */
export interface Image {
  id: number;
  batch_id: number;
  filename: string;
  filepath: string;
  is_checked: boolean;
  created_at: string;
}

/** Image row for the dashboard list — includes computed acceptance counts. */
export interface ImageListRow {
  id: number;
  batch_id: number;
  filename: string;
  filepath: string;
  egg_count: number;
  review_count: number;
  needs_review: boolean;
  is_checked: boolean;   // true = human explicitly marked this image as reviewed
}

/** Full image with detections + parent batch threshold for the annotator. */
export interface ImageDetail extends Image {
  confidence_threshold: number;
  detections: Detection[];
}

export interface Batch {
  id: number;
  name: string;
  created_at: string;
  status: BatchStatus;
  image_count: number;
  processed_count: number;
  confidence_threshold: number;
}

/** Batch row enriched with live EPG / severity for the Recent-analyses table. */
export interface BatchListRow extends Batch {
  total_eggs: number;
  epg: number;
  severity: "Light" | "Moderate" | "Heavy";
}

export interface BatchDetail extends Batch {
  images: Image[];
}

export interface Progress {
  batch_id: number;
  status: BatchStatus;
  image_count: number;
  processed_count: number;
  elapsed_seconds: number | null;  // set once inference finishes, null while running
}

export interface SummaryImageRow {
  image_id: number;
  filename: string;
  egg_count: number;
  review_count: number;
  needs_review: boolean;
}

export interface Summary {
  batch_id: number;
  batch_name: string;
  total_eggs: number;
  epg: number;
  image_count: number;
  positive_count: number;
  avg_confidence: number | null;   // null when batch has no YOLO detections
  severity: string;
  threshold: number;
  images: SummaryImageRow[];
}
