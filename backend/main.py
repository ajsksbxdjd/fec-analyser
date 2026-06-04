from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from database import Base, engine, run_migrations
from routers import batches, detections, images, inference, reports

STORAGE_ROOT = Path(__file__).parent / "storage"
UPLOADS_DIR = STORAGE_ROOT / "uploads"
MODELS_DIR = STORAGE_ROOT / "models"


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Ensure directories exist before mounting static files
    UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    # Create all DB tables, then apply additive column migrations
    Base.metadata.create_all(bind=engine)
    run_migrations()
    # Warm up ML model if best.pt is present
    model_path = MODELS_DIR / "best.pt"
    if model_path.exists():
        try:
            from ml.detector import get_model
            get_model()
        except Exception as e:
            print(f"[startup] Model warm-up failed: {e}")
    else:
        print(f"[startup] best.pt not found at {model_path}. Place it there before running inference.")
    yield


app = FastAPI(title="FEC API", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],        # allow any origin (localhost or LAN IP)
    allow_credentials=False,    # must be False when allow_origins=["*"]
    allow_methods=["*"],
    allow_headers=["*"],
)

# Serve uploaded images as static files
app.mount("/uploads", StaticFiles(directory=str(UPLOADS_DIR)), name="uploads")

# Register routers
app.include_router(batches.router)
app.include_router(images.router)
app.include_router(detections.router)
app.include_router(inference.router)
app.include_router(reports.router)


@app.get("/health")
def health():
    return {"status": "ok"}
