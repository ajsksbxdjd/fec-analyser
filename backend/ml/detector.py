from pathlib import Path

MODEL_PATH = Path(__file__).parent.parent / "storage" / "models" / "best.pt"

# ── Tunable parameters ────────────────────────────────────────────────────────
# BATCH_SIZE: images per GPU forward pass. Increase if you have more VRAM
#   (16 suits 6-8 GB VRAM at imgsz=640). Lower to 4-8 on CPU / low VRAM.
BATCH_SIZE = 16

# IMG_SIZE: inference resolution. 640 = default YOLOv8 accuracy.
#   Try 416 or 320 for faster inference if small egg detection still holds.
IMG_SIZE = 640
# ─────────────────────────────────────────────────────────────────────────────

_model = None


def _cuda_available() -> bool:
    try:
        import torch
        return torch.cuda.is_available()
    except Exception:
        return False


def get_model():
    global _model
    if _model is None:
        try:
            import torch
            from ultralytics import YOLO
        except ImportError as e:
            raise RuntimeError(f"Missing dependency: {e}. Install ultralytics and torch.") from e

        if not MODEL_PATH.exists():
            raise FileNotFoundError(
                f"Model not found at {MODEL_PATH}. "
                "Place best.pt in backend/storage/models/"
            )

        gpu = _cuda_available()
        device = "cuda" if gpu else "cpu"
        print(f"[detector] Loading {MODEL_PATH.name} on {device}")

        model = YOLO(str(MODEL_PATH))
        model.to(device)

        if gpu:
            # Let cuDNN auto-tune kernel selection for the fixed input shape.
            # First batch is slightly slower while it benchmarks, then ~15% faster.
            torch.backends.cudnn.benchmark = True

        _model = model
        print(
            f"[detector] Ready — device={device}, "
            f"batch={BATCH_SIZE}, imgsz={IMG_SIZE}, half={gpu}"
        )
    return _model


def _parse_results(results) -> list[list[dict]]:
    """Convert ultralytics Results objects → list of detection dicts per image."""
    all_detections: list[list[dict]] = []
    for result in results:
        img_h, img_w = result.orig_shape[0], result.orig_shape[1]  # (H, W)
        dets: list[dict] = []
        for box in result.boxes:
            x1, y1, x2, y2 = box.xyxy[0].tolist()
            dets.append({
                "x_center":   ((x1 + x2) / 2) / img_w,
                "y_center":   ((y1 + y2) / 2) / img_h,
                "width":      (x2 - x1) / img_w,
                "height":     (y2 - y1) / img_h,
                "confidence": float(box.conf[0]),
            })
        all_detections.append(dets)
    return all_detections


def run_batch_inference(image_paths: list[str]) -> list[list[dict]]:
    """
    Run inference on a list of image paths.

    Images are fed to the model in chunks of BATCH_SIZE so the GPU processes
    multiple images in a single forward pass — much faster than one-at-a-time.
    Returns one list of detection dicts per input image (same order).
    """
    model = get_model()
    gpu = _cuda_available()
    all_detections: list[list[dict]] = []

    for i in range(0, len(image_paths), BATCH_SIZE):
        chunk = image_paths[i : i + BATCH_SIZE]
        results = model(
            chunk,
            imgsz=IMG_SIZE,
            half=gpu,       # FP16 on GPU: ~2× faster, negligible accuracy loss
            verbose=False,
            stream=False,   # False is faster for known-size chunks
        )
        all_detections.extend(_parse_results(results))

    return all_detections


def run_inference(image_path: str) -> list[dict]:
    """Single-image wrapper kept for compatibility."""
    return run_batch_inference([image_path])[0]
