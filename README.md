# FEC Analyser — Fecal Egg Count Tool

A full-stack web application for automated hookworm egg detection and counting in microscopy images. Upload fecal flotation slide images, run YOLOv8 inference, and review results through an interactive annotation dashboard.

---

## What it does

- **Automated detection** — runs YOLOv8s on batches of microscopy images to locate and count hookworm eggs
- **Adjustable confidence threshold** — boxes below the threshold are flagged "needs review" and float to the top of the image list; changing the threshold re-buckets everything instantly without re-running inference
- **Per-box review workflow** — confirm or remove individual low-confidence detections; add manual annotations by drawing boxes directly on the image
- **Live dashboard** — EPG (eggs per gram × 24), infection severity (WHO hookworm scale: Light / Moderate / Heavy), average YOLO confidence, and a per-image review checklist that updates in real time
- **CSV export** — per-image egg counts, total eggs, EPG, and confidence threshold in one download
- **Inline batch renaming** — click any batch name to rename it in place

---

## Tech stack

| Layer | Technology |
|---|---|
| Backend API | FastAPI 0.115, Uvicorn, Python 3.10+ |
| Database | SQLite via SQLAlchemy 2.0 |
| ML inference | Ultralytics YOLOv8n (`best.pt`) |
| Frontend | Next.js 15, React 19, TypeScript |
| Styling | Tailwind CSS v4, lucide-react |

---

## Project structure

```
FYP/
├── backend/
│   ├── main.py              # FastAPI app entry point
│   ├── models.py            # SQLAlchemy ORM models
│   ├── schemas.py           # Pydantic request/response schemas
│   ├── database.py          # DB session + idempotent migrations
│   ├── scoring.py           # Shared detection acceptance logic
│   ├── requirements.txt
│   ├── routers/
│   │   ├── batches.py       # Batch CRUD, image list, summary, threshold
│   │   ├── detections.py    # Add, confirm, delete detections
│   │   ├── images.py        # Image detail, toggle reviewed flag
│   │   ├── inference.py     # Run YOLOv8 inference (background task)
│   │   └── reports.py       # CSV export
│   ├── ml/
│   │   └── detector.py      # YOLOv8 model loader + batch inference
│   └── storage/
│       ├── models/
│       │   └── best.pt      # trained model weights (included in repo)
│       └── uploads/         # uploaded images (you must create this folder)
└── frontend/
    ├── app/
    │   ├── layout.tsx        # Root layout (Navbar, Inter font)
    │   └── batches/
    │       ├── page.tsx      # Workspace: upload + recent analyses
    │       └── [id]/
    │           └── page.tsx  # Dashboard + review annotator
    ├── components/
    │   ├── ImageAnnotator.tsx  # CSS overlay annotator
    │   ├── ChecklistPanel.tsx  # Image list sidebar
    │   ├── BatchUpload.tsx     # Upload form with progress
    │   ├── InlineEdit.tsx      # Inline rename component
    │   └── Navbar.tsx
    └── lib/
        ├── api.ts            # All API calls
        └── types.ts          # TypeScript interfaces
```

---

## First-time setup

Do this **once** after cloning. You will not need to repeat these steps every time you run the app.

### Prerequisites

Make sure you have these installed before starting:

- **Python 3.10 or newer** — https://www.python.org/downloads/
- **Node.js 18 or newer** — https://nodejs.org/
- **Git** — https://git-scm.com/

---

### 1. Clone the repository

```bash
git clone https://github.com/ajsksbxdjd/hookworm.git
cd hookworm
```

---

### 2. Backend — create the virtual environment

A virtual environment keeps the Python packages for this project separate from everything else on your machine. You only create it once.

```bash
cd backend
```

**Create the venv:**

```bash
# Windows
python -m venv venv

# Mac / Linux
python3 -m venv venv
```

**Activate it:**

```bash
# Windows — Command Prompt
venv\Scripts\activate

# Windows — PowerShell
venv\Scripts\Activate.ps1

# Mac / Linux
source venv/bin/activate
```

You'll know it worked when `(venv)` appears at the start of your terminal prompt.

**Install all Python packages:**

```bash
pip install -r requirements.txt
```

> This installs FastAPI, Uvicorn, SQLAlchemy, Ultralytics YOLOv8, pandas, Pillow, and everything else the backend needs. Takes a few minutes the first time — you will not need to run this again unless `requirements.txt` changes.

---

### 3. Create the uploads folder

The uploads folder is not tracked by Git and must be created manually once:

```bash
# Windows
mkdir storage\uploads

# Mac / Linux
mkdir -p storage/uploads
```

> The backend will fail to start without this folder. You only need to do this once — uploaded images will be saved here automatically when you use the app.

---

### 4. Frontend — install JavaScript packages

Open a **second terminal** (or navigate back to the project root):

```bash
cd frontend
npm install
```

> This installs Next.js, React, Tailwind CSS, lucide-react, and all other dependencies into a `node_modules` folder. Takes a couple of minutes once. After this you do **not** need to run `npm install` again unless `package.json` changes (e.g. after a `git pull` that adds new packages).

---

## Running the app (every time)

You need **two terminals** running simultaneously — one for the backend API, one for the frontend dev server.

### Terminal 1 — Backend

```bash
cd backend

# Activate the virtual environment (required every new terminal session):
# Windows:   venv\Scripts\activate
# Mac/Linux: source venv/bin/activate

uvicorn main:app --host 0.0.0.0 --reload
```

The API will be running at **http://localhost:8000**

> `--reload` auto-restarts when you change a Python file — useful during development.  
> `--host 0.0.0.0` lets other devices on the same Wi-Fi reach the app (handy for demos).

---

### Terminal 2 — Frontend

```bash
cd frontend
npm run dev
```

The app will be available at **http://localhost:3000**

---

Open **http://localhost:3000** in your browser. Both terminals must stay running while you use the app.

---

## How to use

1. **Create a batch** — on the workspace, enter a sample label, drop in JPG / PNG images or a ZIP archive, and click **Start analysis**
2. **Wait for inference** — a live progress bar and elapsed timer show how many images have been processed; the dashboard opens automatically when done
3. **Review detections**
   - **Green boxes** = accepted (confidence ≥ threshold, or manually confirmed)
   - **Amber boxes** = needs review (confidence below threshold, unconfirmed)
   - **Blue boxes** = manually drawn
   - Images with amber boxes appear at the top of the sidebar
   - Click an amber box → **Confirm egg** (counts it) or **Remove** (discards it)
4. **Add a box** — toggle **Add box** mode, then drag a rectangle over an egg the model missed; it is counted immediately at 100% confidence
5. **Adjust threshold** — use the threshold input (top toolbar) to tighten or loosen acceptance. The EPG and review list update instantly — no re-inference needed
6. **Mark reviewed** — once you are satisfied with an image, click **Mark reviewed** to move it to the Reviewed section in the sidebar
7. **Export** — click **↓ CSV** to download a spreadsheet with per-image counts, total eggs, EPG, and the confidence threshold used

---

## GPU vs CPU inference

The backend auto-detects CUDA. If you have a compatible NVIDIA GPU with the CUDA toolkit installed, inference runs on the GPU (much faster). Otherwise it falls back to CPU — no config changes needed.

Watch the backend terminal when you submit a batch; it will log `device=cuda` or `device=cpu`.

To tune performance, edit `backend/ml/detector.py`:
- `BATCH_SIZE` — images per forward pass (default 16, lower this on low-VRAM machines)
- `IMG_SIZE` — inference resolution (default 640)

---

## Common issues

| Problem | Fix |
|---|---|
| `ModuleNotFoundError` when starting backend | Virtual environment not activated — run `venv\Scripts\activate` (Windows) or `source venv/bin/activate` (Mac/Linux) before `uvicorn` |
| `Directory 'storage/uploads' does not exist` | Run `mkdir storage\uploads` inside the `backend/` folder |
| Frontend shows network errors | Make sure the backend is running on port 8000 before opening the browser |
| `npm run dev` fails immediately | Run `npm install` inside the `frontend/` folder first |
| Images don't appear after upload | Check that `backend/storage/uploads/` exists and the backend terminal shows no file-permission errors |
| PowerShell blocks venv activation | Run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once, then retry |
