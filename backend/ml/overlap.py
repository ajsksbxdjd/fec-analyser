"""
Overlap detection and cross-image egg deduplication for a slide batch.

Microscope fields of view on one slide often overlap, so the same egg can be
detected in two (or more) images and get counted twice. This module:

  1. Describes every image with ORB features (on a small 250 px working copy).
  2. Matches every image pair (ratio test) and confirms real overlaps with a
     RANSAC homography.
  3. Groups overlapping images into clusters (union-find) and maps every box
     center into one "root" image of the cluster.
  4. Any two boxes from DIFFERENT images whose mapped centers are within
     DEDUP_DISTANCE_PX are treated as the same egg; the weaker one is flagged
     as a duplicate of the stronger one.

It is pure computation: it takes image paths + normalized boxes and returns
which boxes are duplicates. Writing results to the DB lives in dedup.py.

Note: ORB has limited scale invariance — pairs at very different zoom levels
may produce zero matches even when the regions truly overlap.
"""

from __future__ import annotations

import json
import os
import statistics
import time
from dataclasses import dataclass, field
from pathlib import Path

import cv2
import numpy as np

# ── Tunable parameters ────────────────────────────────────────────────────────
# MIN_GOOD_MATCHES and DEDUP_DISTANCE_PX are the most likely to need adjusting
# against real slide data (check overlap_debug_report.json after a run).
# Speed vs. accuracy (benchmarked on 611 real slide images; matching time
# grows with features^2 and with images^2):
#   250 px / 200 features : match  34 s, caught  8/12 synthetic + 1/2 real overlaps
#   500 px / 500 features : match 208 s, caught 12/12 synthetic + 2/2 real   <- used
#   500 px / 1000 features: match 641 s, caught 12/12 synthetic + 2/2 real
# (200 images is ~9x fewer pairs than 611.)
ORB_WORKING_WIDTH = 500
ORB_MAX_FEATURES = 500
RATIO_TEST_THRESH = 0.75
MIN_GOOD_MATCHES = 15
MIN_INLIER_MATCHES = 10
RANSAC_REPROJ_THRESHOLD = 5.0  # pixels in ORB working space
DEDUP_DISTANCE_PX = 40         # full-res pixel center distance for duplicate boxes

# Matched feature pairs kept per overlap as visual evidence for the reviewer
EVIDENCE_MAX_MATCHES = 60

DEBUG_CONSOLE_TOP_N = 30
DEBUG_IMAGE_TOP_N = 15
# ─────────────────────────────────────────────────────────────────────────────


@dataclass
class OverlapStats:
    total_images: int = 0
    total_pairs_checked: int = 0
    candidate_pairs: int = 0
    confirmed_pairs: int = 0
    duplicates_found: int = 0
    elapsed_seconds: float = 0.0
    match_count_min: int = 0
    match_count_max: int = 0
    match_count_median: float = 0.0
    match_count_histogram: dict[str, int] = field(default_factory=dict)


@dataclass
class BoxIn:
    """A box to consider for dedup. Coordinates are normalized 0-1 (YOLO style)."""
    key: int              # caller's id (e.g. Detection.id)
    x_center: float
    y_center: float
    width: float
    height: float
    score: float          # higher wins when two boxes are the same egg
    protected: bool = False  # never flag this box as a duplicate (human override)


@dataclass
class DuplicateMatch:
    duplicate_key: int    # box flagged as a duplicate
    kept_key: int         # box it duplicates (the one that keeps counting)


@dataclass
class OverlapPair:
    """A confirmed overlap between image i and image j (indices into image_paths)."""
    i: int
    j: int
    inliers: int
    h_j_to_i: list[float]   # 3x3 row-major, maps image-j full-res px -> image-i full-res px
    size_i: tuple[int, int] # (width, height) full-res
    size_j: tuple[int, int]
    # RANSAC-inlier feature matches, normalized: [x_i, y_i, x_j, y_j] (0-1 in each image)
    matches: list[list[float]] = field(default_factory=list)


@dataclass
class _PairwiseRecord:
    i: int
    j: int
    image_i: str
    image_j: str
    good_match_count: int
    is_candidate: bool
    ransac_ran: bool = False
    confirmed_inliers: int | None = None
    overlap_confirmed: bool = False


@dataclass
class _ImageDesc:
    path: str
    orig_w: int
    orig_h: int
    scale: float
    keypoints: list
    descriptors: np.ndarray | None


@dataclass
class _ConfirmedPair:
    i: int
    j: int
    h_j_to_i_full: np.ndarray  # maps image-j full-res coords -> image-i full-res coords
    inliers: int = 0
    evidence: list[list[float]] = field(default_factory=list)


@dataclass
class _BoxRef:
    img_idx: int
    box: BoxIn
    root_cx: float
    root_cy: float


class _UnionFind:
    def __init__(self, n: int) -> None:
        self.parent = list(range(n))

    def find(self, x: int) -> int:
        while self.parent[x] != x:
            self.parent[x] = self.parent[self.parent[x]]
            x = self.parent[x]
        return x

    def union(self, a: int, b: int) -> None:
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.parent[rb] = ra


# ── geometry helpers ─────────────────────────────────────────────────────────

def _scale_matrix(scale: float) -> np.ndarray:
    return np.array([[scale, 0.0, 0.0], [0.0, scale, 0.0], [0.0, 0.0, 1.0]], dtype=np.float64)


def _scale_homography_to_fullres(h_work: np.ndarray, scale_i: float, scale_j: float) -> np.ndarray:
    """Convert homography from working space (j -> i) to full-res (j -> i)."""
    return np.linalg.inv(_scale_matrix(scale_i)) @ h_work @ _scale_matrix(scale_j)


def _warp_point(h: np.ndarray, x: float, y: float) -> tuple[float, float]:
    warped = h @ np.array([x, y, 1.0], dtype=np.float64)
    if abs(warped[2]) < 1e-8:
        return x, y
    return float(warped[0] / warped[2]), float(warped[1] / warped[2])


def _center_distance(a: tuple[float, float], b: tuple[float, float]) -> float:
    return ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2) ** 0.5


# ── ORB description + matching ───────────────────────────────────────────────

def _load_and_resize_gray(path: str) -> tuple[np.ndarray, int, int, float]:
    # np.fromfile + imdecode handles non-ASCII Windows paths, unlike cv2.imread
    data = np.fromfile(path, dtype=np.uint8)
    img = cv2.imdecode(data, cv2.IMREAD_GRAYSCALE) if data.size else None
    if img is None:
        raise ValueError(f"Failed to load image: {path}")

    orig_h, orig_w = img.shape[:2]
    scale = ORB_WORKING_WIDTH / max(orig_w, orig_h)
    new_w = max(1, int(round(orig_w * scale)))
    new_h = max(1, int(round(orig_h * scale)))
    resized = cv2.resize(img, (new_w, new_h), interpolation=cv2.INTER_AREA)
    return resized, orig_w, orig_h, scale


def _describe_images(image_paths: list[str]) -> list[_ImageDesc]:
    orb = cv2.ORB_create(nfeatures=ORB_MAX_FEATURES)
    cache: list[_ImageDesc] = []
    for path in image_paths:
        gray, orig_w, orig_h, scale = _load_and_resize_gray(path)
        keypoints, descriptors = orb.detectAndCompute(gray, None)
        cache.append(_ImageDesc(
            path=path,
            orig_w=orig_w,
            orig_h=orig_h,
            scale=scale,
            keypoints=list(keypoints or []),
            descriptors=descriptors,
        ))
    return cache


def _ratio_test_matches(desc_a: np.ndarray | None, desc_b: np.ndarray | None) -> list:
    if desc_a is None or desc_b is None or len(desc_a) < 2 or len(desc_b) < 2:
        return []
    matcher = cv2.BFMatcher(cv2.NORM_HAMMING)
    good = []
    for pair in matcher.knnMatch(desc_a, desc_b, k=2):
        if len(pair) < 2:
            continue
        m, n = pair
        if m.distance < RATIO_TEST_THRESH * n.distance:
            good.append(m)
    return good


def _match_all_pairs(cache: list[_ImageDesc], image_names: list[str]):
    n = len(cache)
    candidates: list[tuple[int, int, list]] = []
    records: list[_PairwiseRecord] = []
    all_good_counts: list[int] = []

    for i in range(n):
        for j in range(i + 1, n):
            good = _ratio_test_matches(cache[i].descriptors, cache[j].descriptors)
            is_candidate = len(good) >= MIN_GOOD_MATCHES
            all_good_counts.append(len(good))
            records.append(_PairwiseRecord(
                i=i, j=j,
                image_i=image_names[i], image_j=image_names[j],
                good_match_count=len(good),
                is_candidate=is_candidate,
            ))
            if is_candidate:
                candidates.append((i, j, good))

    return candidates, records, all_good_counts


def _match_count_histogram(counts: list[int]) -> dict[str, int]:
    buckets = {"0": 0, "1-4": 0, "5-9": 0, "10-14": 0, "15-29": 0, "30+": 0}
    for c in counts:
        if c == 0:
            buckets["0"] += 1
        elif c <= 4:
            buckets["1-4"] += 1
        elif c <= 9:
            buckets["5-9"] += 1
        elif c <= 14:
            buckets["10-14"] += 1
        elif c <= 29:
            buckets["15-29"] += 1
        else:
            buckets["30+"] += 1
    return buckets


def _plausible_homography(h: np.ndarray) -> bool:
    """
    Reject transforms a microscope stage can't produce: mirror flips, big zoom
    changes, strong perspective. Real neighbouring fields are ~shift (+ maybe a
    small rotation / zoom), so this mainly filters chance RANSAC fits.
    """
    if abs(h[2, 2]) < 1e-8:
        return False
    h = h / h[2, 2]
    a = h[:2, :2]
    if np.linalg.det(a) <= 0:
        return False
    sv = np.linalg.svd(a, compute_uv=False)
    if sv.min() < 0.5 or sv.max() > 2.0:
        return False
    return bool(np.abs(h[2, :2]).max() < 2e-3)


def _evidence(pts_i, pts_j, mask, desc_i: _ImageDesc, desc_j: _ImageDesc) -> list[list[float]]:
    """Up to EVIDENCE_MAX_MATCHES inlier matches, evenly sampled, normalized to 0-1."""
    keep = mask.ravel().astype(bool)
    a = pts_i.reshape(-1, 2)[keep]
    b = pts_j.reshape(-1, 2)[keep]
    if len(a) > EVIDENCE_MAX_MATCHES:
        idx = np.linspace(0, len(a) - 1, EVIDENCE_MAX_MATCHES).round().astype(int)
        a, b = a[idx], b[idx]
    # working-space px -> full-res px -> normalized
    wi, hi = desc_i.scale * desc_i.orig_w, desc_i.scale * desc_i.orig_h
    wj, hj = desc_j.scale * desc_j.orig_w, desc_j.scale * desc_j.orig_h
    return [
        [round(float(p[0] / wi), 4), round(float(p[1] / hi), 4), round(float(q[0] / wj), 4), round(float(q[1] / hj), 4)]
        for p, q in zip(a, b)
    ]


def _confirm_overlaps(candidates, cache, records_by_pair) -> list[_ConfirmedPair]:
    confirmed: list[_ConfirmedPair] = []
    for i, j, good in candidates:
        rec = records_by_pair[(i, j)]
        rec.ransac_ran = True

        pts_i = np.float32([cache[i].keypoints[m.queryIdx].pt for m in good]).reshape(-1, 1, 2)
        pts_j = np.float32([cache[j].keypoints[m.trainIdx].pt for m in good]).reshape(-1, 1, 2)

        h_work, mask = cv2.findHomography(pts_j, pts_i, cv2.RANSAC, RANSAC_REPROJ_THRESHOLD)
        if h_work is None or mask is None:
            rec.confirmed_inliers = 0
            continue

        inliers = int(mask.ravel().sum())
        rec.confirmed_inliers = inliers
        if inliers < MIN_INLIER_MATCHES:
            continue

        if not _plausible_homography(h_work):
            continue

        rec.overlap_confirmed = True
        h_full = _scale_homography_to_fullres(h_work, cache[i].scale, cache[j].scale)
        confirmed.append(_ConfirmedPair(
            i=i, j=j, h_j_to_i_full=h_full, inliers=inliers,
            evidence=_evidence(pts_i, pts_j, mask, cache[i], cache[j]),
        ))
    return confirmed


# ── clustering + dedup ───────────────────────────────────────────────────────

def _build_clusters(n: int, confirmed: list[_ConfirmedPair]) -> list[list[int]]:
    uf = _UnionFind(n)
    for pair in confirmed:
        uf.union(pair.i, pair.j)
    clusters: dict[int, list[int]] = {}
    for idx in range(n):
        clusters.setdefault(uf.find(idx), []).append(idx)
    return [sorted(v) for v in clusters.values() if len(v) > 1]


def _compose_homographies_to_root(cluster, root, confirmed) -> dict[int, np.ndarray]:
    """BFS over confirmed pairs: H mapping each member's full-res coords into root's."""
    members = set(cluster)
    adjacency: dict[int, list[tuple[int, np.ndarray]]] = {idx: [] for idx in cluster}
    for pair in confirmed:
        if pair.i not in members or pair.j not in members:
            continue
        try:
            h_i_to_j = np.linalg.inv(pair.h_j_to_i_full)
        except np.linalg.LinAlgError:
            continue
        adjacency[pair.i].append((pair.j, pair.h_j_to_i_full))  # neighbor j -> current i
        adjacency[pair.j].append((pair.i, h_i_to_j))            # neighbor i -> current j

    homographies = {root: np.eye(3, dtype=np.float64)}
    queue = [root]
    while queue:
        current = queue.pop(0)
        for neighbor, h_neighbor_to_current in adjacency[current]:
            if neighbor in homographies:
                continue
            homographies[neighbor] = homographies[current] @ h_neighbor_to_current
            queue.append(neighbor)
    return homographies


def _dedup_cluster(cluster, root, homographies, sizes, boxes_per_image) -> list[DuplicateMatch]:
    refs: list[_BoxRef] = []
    for img_idx in cluster:
        h = homographies.get(img_idx)
        if h is None:
            continue
        w, hgt = sizes[img_idx]
        for box in boxes_per_image[img_idx]:
            cx, cy = box.x_center * w, box.y_center * hgt  # normalized -> full-res px
            rcx, rcy = (cx, cy) if img_idx == root else _warp_point(h, cx, cy)
            refs.append(_BoxRef(img_idx=img_idx, box=box, root_cx=rcx, root_cy=rcy))

    # Strongest first, so the "kept" set is decided greedily from most to least
    # trustworthy. Protected boxes (researcher said "not a duplicate") always
    # count and are left out of matching entirely, so overriding one box never
    # pushes the duplicate flag onto its former partner.
    refs = [r for r in refs if not r.box.protected]
    refs.sort(key=lambda r: (-r.box.score, r.img_idx != root, r.img_idx))

    kept: list[_BoxRef] = []
    matches: list[DuplicateMatch] = []
    for ref in refs:
        conflict = None
        for k in kept:
            # Same-image neighbours are separate eggs (YOLO already ran NMS);
            # only boxes from different images can be the same physical egg.
            if k.img_idx == ref.img_idx:
                continue
            if _center_distance((ref.root_cx, ref.root_cy), (k.root_cx, k.root_cy)) <= DEDUP_DISTANCE_PX:
                conflict = k
                break
        if conflict is None:
            kept.append(ref)
        else:
            matches.append(DuplicateMatch(duplicate_key=ref.box.key, kept_key=conflict.box.key))
    return matches


# ── debug output ─────────────────────────────────────────────────────────────

def _write_debug(debug_dir: Path, records: list[_PairwiseRecord], cache: list[_ImageDesc]) -> None:
    debug_dir.mkdir(parents=True, exist_ok=True)
    images_dir = debug_dir / "overlap_debug"
    report_path = debug_dir / "overlap_debug_report.json"
    sorted_records = sorted(records, key=lambda r: r.good_match_count, reverse=True)

    report = {
        "thresholds": {
            "MIN_GOOD_MATCHES": MIN_GOOD_MATCHES,
            "MIN_INLIER_MATCHES": MIN_INLIER_MATCHES,
            "DEDUP_DISTANCE_PX": DEDUP_DISTANCE_PX,
        },
        "total_pairs": len(records),
        "pairs": [
            {
                "image_i_name": r.image_i,
                "image_j_name": r.image_j,
                "good_match_count": r.good_match_count,
                "is_candidate": r.is_candidate,
                "ransac_ran": r.ransac_ran,
                "confirmed_inliers": r.confirmed_inliers,
                "overlap_confirmed": r.overlap_confirmed,
            }
            for r in sorted_records
        ],
    }
    report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"[overlap] debug report written — {report_path} ({len(records)} pairs)")

    print(f"[overlap] top {DEBUG_CONSOLE_TOP_N} pairs by good_match_count:")
    print("image_i | image_j | good_matches | candidate | inliers | overlap")
    for r in sorted_records[:DEBUG_CONSOLE_TOP_N]:
        inliers = r.confirmed_inliers if r.ransac_ran else "-"
        print(f"{r.image_i} | {r.image_j} | {r.good_match_count} | {r.is_candidate} | {inliers} | {r.overlap_confirmed}")

    images_dir.mkdir(parents=True, exist_ok=True)
    saved = 0
    for r in sorted_records:
        if r.good_match_count == 0 or saved >= DEBUG_IMAGE_TOP_N:
            break
        good = _ratio_test_matches(cache[r.i].descriptors, cache[r.j].descriptors)
        img_i = cv2.cvtColor(_load_and_resize_gray(cache[r.i].path)[0], cv2.COLOR_GRAY2BGR)
        img_j = cv2.cvtColor(_load_and_resize_gray(cache[r.j].path)[0], cv2.COLOR_GRAY2BGR)
        vis = cv2.drawMatches(
            img_i, cache[r.i].keypoints, img_j, cache[r.j].keypoints, good, None,
            matchColor=(0, 255, 0), singlePointColor=(255, 0, 0),
            flags=cv2.DrawMatchesFlags_NOT_DRAW_SINGLE_POINTS,
        )
        tag = "OVERLAP" if r.overlap_confirmed else "no"
        out_name = f"{saved + 1:02d}_{tag}_{Path(r.image_i).stem}__{Path(r.image_j).stem}.jpg"
        ok, buf = cv2.imencode(".jpg", vis)
        if ok:
            buf.tofile(str(images_dir / out_name))
            saved += 1
    print(f"[overlap] debug match images written — {images_dir} ({saved} images)")


# ── public entry points ──────────────────────────────────────────────────────

def find_overlaps(
    image_paths: list[str],
    debug_dir: Path | None = None,
) -> tuple[OverlapStats, list[OverlapPair]]:
    """
    Slow part (~1-2 min for 200 images): find which images overlap and how they
    map onto each other. Pair indices refer to image_paths. If debug_dir is
    given, a JSON report + match visualisations are written there.
    """
    start = time.perf_counter()
    stats = OverlapStats(total_images=len(image_paths))
    if len(image_paths) < 2:
        stats.elapsed_seconds = round(time.perf_counter() - start, 2)
        return stats, []

    image_names = [Path(p).name for p in image_paths]
    # Ultralytics calls cv2.setNumThreads(0) on import, which makes OpenCV
    # single-threaded in the server process: pairwise matching on 200 images
    # went from ~45 s to ~5 min. Use all cores here, then restore.
    prev_threads = cv2.getNumThreads()
    cv2.setNumThreads(os.cpu_count() or 4)
    try:
        cache = _describe_images(image_paths)
        candidates, records, all_good_counts = _match_all_pairs(cache, image_names)
    finally:
        cv2.setNumThreads(prev_threads)
    records_by_pair = {(r.i, r.j): r for r in records}
    confirmed = _confirm_overlaps(candidates, cache, records_by_pair)

    if debug_dir is not None:
        try:
            _write_debug(debug_dir, records, cache)
        except Exception as e:  # debug output must never break dedup
            print(f"[overlap] debug output failed: {e}")

    stats.total_pairs_checked = len(records)
    stats.candidate_pairs = len(candidates)
    stats.confirmed_pairs = len(confirmed)
    stats.elapsed_seconds = round(time.perf_counter() - start, 2)
    if all_good_counts:
        stats.match_count_min = min(all_good_counts)
        stats.match_count_max = max(all_good_counts)
        stats.match_count_median = float(statistics.median(all_good_counts))
        stats.match_count_histogram = _match_count_histogram(all_good_counts)

    print(
        f"[overlap] {stats.total_images} images — "
        f"{stats.candidate_pairs}/{stats.total_pairs_checked} candidate pairs, "
        f"{stats.confirmed_pairs} confirmed — {stats.elapsed_seconds:.2f}s"
    )
    print(
        f"[overlap] good-match counts — min={stats.match_count_min} "
        f"median={stats.match_count_median:.0f} max={stats.match_count_max} "
        f"histogram={stats.match_count_histogram}"
    )
    pairs = [
        OverlapPair(
            i=p.i,
            j=p.j,
            inliers=p.inliers,
            h_j_to_i=[float(v) for v in p.h_j_to_i_full.ravel()],
            size_i=(cache[p.i].orig_w, cache[p.i].orig_h),
            size_j=(cache[p.j].orig_w, cache[p.j].orig_h),
            matches=p.evidence,
        )
        for p in confirmed
    ]
    return stats, pairs


def dedup_from_pairs(
    sizes: list[tuple[int, int]],
    pairs: list[OverlapPair],
    boxes_per_image: list[list[BoxIn]],
) -> list[DuplicateMatch]:
    """
    Fast part (milliseconds): given overlaps (e.g. stored ones, minus any the
    reviewer rejected), decide which boxes are the same egg. Indices in pairs
    refer to sizes / boxes_per_image.
    """
    confirmed = [
        _ConfirmedPair(i=p.i, j=p.j, h_j_to_i_full=np.array(p.h_j_to_i, dtype=np.float64).reshape(3, 3))
        for p in pairs
    ]
    matches: list[DuplicateMatch] = []
    for cluster in _build_clusters(len(sizes), confirmed):
        root = cluster[0]
        homographies = _compose_homographies_to_root(cluster, root, confirmed)
        matches.extend(_dedup_cluster(cluster, root, homographies, sizes, boxes_per_image))
    return matches


def find_duplicates(
    image_paths: list[str],
    boxes_per_image: list[list[BoxIn]],
    debug_dir: Path | None = None,
) -> tuple[list[DuplicateMatch], OverlapStats, list[OverlapPair]]:
    """find_overlaps + dedup_from_pairs in one call."""
    if len(image_paths) != len(boxes_per_image):
        raise ValueError("image_paths and boxes_per_image must have the same length")
    stats, pairs = find_overlaps(image_paths, debug_dir)
    if not pairs:
        return [], stats, pairs
    sizes = [(0, 0)] * len(image_paths)
    for p in pairs:
        sizes[p.i], sizes[p.j] = p.size_i, p.size_j
    matches = dedup_from_pairs(sizes, pairs, boxes_per_image)
    stats.duplicates_found = len(matches)
    return matches, stats, pairs
