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
  /** Same egg already counted in an overlapping image — excluded from counts. */
  is_duplicate: boolean;
  duplicate_of_id: number | null;
  duplicate_of_filename: string | null;
  duplicate_of_image_id: number | null;
  /** Researcher marked "not a duplicate" — dedup will never flag it again. */
  keep_override: boolean;
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
  duplicate_count: number;
  overlap_count: number; // how many other images overlap this one
}

export type OverlapStatus = "auto" | "confirmed" | "rejected";

/** Another image that overlaps this one (from the last dedup run). */
export interface OverlapPartner {
  overlap_id: number;               // <= 0 when linked only through a third image
  image_id: number;
  filename: string;
  inliers: number;                  // overlap strength
  strength: "strong" | "weak";      // weak ones deserve a human look
  status: OverlapStatus;            // reviewer decision
  region_here: [number, number][];  // partner's outline in THIS image, normalized 0-1
  region_there: [number, number][]; // this image's outline in the partner, normalized 0-1
  /** Evidence: matched features [x_here, y_here, x_there, y_there], normalized 0-1. */
  matches: [number, number, number, number][];
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
  duplicate_count: number;
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
  duplicate_count: number;        // boxes excluded as cross-image duplicates
  overlap_pairs: number | null;   // confirmed overlapping image pairs; null = dedup never ran
  images: SummaryImageRow[];
}

export interface DedupResult {
  batch_id: number;
  total_images: number;
  pairs_checked: number;
  candidate_pairs: number;
  overlap_pairs: number;
  duplicates_found: number;
  elapsed_seconds: number;
}
