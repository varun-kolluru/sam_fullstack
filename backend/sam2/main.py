"""
SAM-2 Video Segmentation API
storage/
  videos/<video_name>.mp4
  frames/<video_name>/00000.jpg …
  masks/<video_name>/00000_<obj_id>_<label>.png …
"""

import base64
import io
import os
import uuid
import cv2
import numpy as np
from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from PIL import Image
from pydantic import BaseModel, Field
from sam2_service import SAM2Service

# ── App setup ──────────────────────────────────────────────────────────────
app = FastAPI(title="SAM-2 Video Segmentation API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

BASE_DIR = "storage"
VIDEO_DIR = os.path.join(BASE_DIR, "videos")
FRAME_DIR = os.path.join(BASE_DIR, "frames")
MASK_DIR = os.path.join(BASE_DIR, "masks")
BATCH_DIR = os.path.join(BASE_DIR, "tmp_batches")

for _d in (VIDEO_DIR, FRAME_DIR, MASK_DIR,BATCH_DIR):
    os.makedirs(_d, exist_ok=True)

app.mount("/storage", StaticFiles(directory=BASE_DIR), name="storage")
sam2 = SAM2Service()

# ── Default color palette (BGR) ────────────────────────────────────────────
_DEFAULT_PALETTE_BGR = [
    (117, 158, 29), (29, 99, 235), (0, 165, 255), (0, 0, 220),
    (128, 0, 128), (0, 128, 128), (203, 192, 255), (42, 255, 255),
]

def _obj_color_bgr(obj_id: int, palette: dict[int, tuple[int, int, int]] | None = None):
    if palette and obj_id in palette:
        return palette[obj_id]
    return _DEFAULT_PALETTE_BGR[(obj_id - 1) % len(_DEFAULT_PALETTE_BGR)]

# ── Helpers ────────────────────────────────────────────────────────────────
def _sanitize_label(label: str) -> str:
    safe = "".join(c if c.isalnum() or c in ('-', '_') else '_' for c in label)
    return safe[:50] if safe else "object"

def _parse_mask_filename(filename: str):
    """Parse mask filename: {frame_idx:05d}_{obj_id}_{label}.png"""
    if not filename.endswith('.png'):
        return None
    parts = filename[:-4].split('_', 2)
    if len(parts) >= 2:
        try:
            return int(parts[0]), int(parts[1]), parts[2] if len(parts) > 2 else f"Object {parts[1]}"
        except ValueError:
            pass
    return None

def _get_object_labels_from_masks(video_name: str):
    """Extract object labels from mask filenames."""
    mdir = _mask_dir(video_name)
    if not os.path.isdir(mdir):
        return {}
    labels_map = {}
    for filename in os.listdir(mdir):
        parsed = _parse_mask_filename(filename)
        if parsed:
            labels_map[str(parsed[1])] = parsed[2]
    return labels_map

def _safe_video_name(raw: str) -> str:
    return os.path.basename(raw).strip()

def _video_path(name: str) -> str:
    return os.path.join(VIDEO_DIR, f"{name}.mp4")

def _frame_dir(name: str) -> str:
    return os.path.join(FRAME_DIR, name)

def _mask_dir(name: str) -> str:
    return os.path.join(MASK_DIR, name)

def _extract_frames(video_path: str, out_dir: str):
    os.makedirs(out_dir, exist_ok=True)
    cap = cv2.VideoCapture(video_path)
    fps = cap.get(cv2.CAP_PROP_FPS)
    idx = 0
    while cap.isOpened():
        ret, frame = cap.read()
        if not ret:
            break
        cv2.imwrite(os.path.join(out_dir, f"{idx:05d}.jpg"), frame)
        idx += 1
    cap.release()
    return idx, fps

def _require_video(name: str):
    if not os.path.exists(_video_path(name)):
        raise HTTPException(status_code=404, detail=f"Video '{name}' not found.")

def _require_frames(name: str):
    fd = _frame_dir(name)
    if not os.path.isdir(fd) or not os.listdir(fd):
        raise HTTPException(status_code=404, detail=f"Frames for '{name}' not found.")

def _save_mask_and_respond(mask: np.ndarray, video_name: str, frame_idx: int, obj_id: int, obj_label: str):
    mdir = _mask_dir(video_name)
    os.makedirs(mdir, exist_ok=True)
    fname = f"{frame_idx:05d}_{obj_id}_{_sanitize_label(obj_label)}.png"
    Image.fromarray(mask).save(os.path.join(mdir, fname))
    return {"mask_path": f"/storage/masks/{video_name}/{fname}"}

# ── Pydantic models ────────────────────────────────────────────────────────
class SelectVideoRequest(BaseModel):
    video_name: str

class SegmentFrameRequest(BaseModel):
    video_name: str
    frame_idx: int
    obj_id: int
    obj_label: str
    positive_points: list[list[int]] | None = None
    negative_points: list[list[int]] | None = None
    box: list[int] | None = None
    mask_b64: str | None = None

class PropagateRequest(BaseModel):
    video_name: str
    start_frame_idx: int = 0
    end_frame_idx: int | None = None

class ObjColorEntry(BaseModel):
    r: int
    g: int
    b: int

class RenderMaskedVideoRequest(BaseModel):
    video_name: str
    alpha: float = 0.45
    obj_colors: dict[str, ObjColorEntry] = Field(default_factory=dict)

# ── Video management endpoints ─────────────────────────────────────────────
@app.get("/videos")
def list_videos():
    names = [f[:-4] for f in os.listdir(VIDEO_DIR) 
             if f.endswith(".mp4") and not f.endswith("_masked.mp4")]
    return {"videos": names}

@app.get("/videos/{video_name}/stream")
def stream_video(video_name: str):
    video_name = _safe_video_name(video_name)
    path = _video_path(video_name)
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail=f"Video '{video_name}' not found.")
    return FileResponse(path, media_type="video/mp4")

@app.get("/videos/{video_name}/info")
def video_info(video_name: str):
    video_name = _safe_video_name(video_name)
    _require_video(video_name)
    _require_frames(video_name)
    
    fd = _frame_dir(video_name)
    total_frames = len([f for f in os.listdir(fd) if f.endswith(".jpg")])
    
    cap = cv2.VideoCapture(_video_path(video_name))
    fps = cap.get(cv2.CAP_PROP_FPS)
    cap.release()
    
    return {"video_name": video_name, "fps": fps, "total_frames": total_frames}

@app.post("/upload-video")
async def upload_video_endpoint(video: UploadFile = File(...), name: str = Query("")):
    video_name = _safe_video_name(name) if name else _safe_video_name(
        video.filename or f"video_{uuid.uuid4().hex[:8]}")
    
    if name and not video_name:
        raise HTTPException(status_code=400, detail="Invalid name.")
    if os.path.exists(_video_path(video_name)):
        raise HTTPException(status_code=409, detail=f"Video '{video_name}' already exists.")
    
    vpath = _video_path(video_name)
    with open(vpath, "wb") as f:
        f.write(await video.read())
    
    fdir = _frame_dir(video_name)
    try:
        total_frames, fps = _extract_frames(vpath, fdir)
    except Exception:
        os.remove(vpath)
        raise HTTPException(status_code=422, detail="Could not extract frames.")
    
    sam2.init_video(video_name, fdir)
    return {"video_name": video_name, "fps": fps, "total_frames": total_frames}

@app.post("/select-video")
def select_video_endpoint(body: SelectVideoRequest):
    video_name = _safe_video_name(body.video_name)
    _require_video(video_name)
    _require_frames(video_name)
    
    sam2.init_video(video_name, _frame_dir(video_name))
    
    cap = cv2.VideoCapture(_video_path(video_name))
    fps = cap.get(cv2.CAP_PROP_FPS)
    cap.release()
    
    fd = _frame_dir(video_name)
    total_frames = len([f for f in os.listdir(fd) if f.endswith(".jpg")])
    
    return {"video_name": video_name, "fps": fps, "total_frames": total_frames}

# ── Segmentation endpoints ─────────────────────────────────────────────────

@app.post("/segment-frame")
def segment_frame_endpoint(req: SegmentFrameRequest):
    # Validate at least one prompt is provided
    has_points = req.positive_points or req.negative_points
    has_box = req.box is not None
    has_mask = req.mask_b64 is not None
    
    if not (has_points or has_box or has_mask):
        raise HTTPException(
            status_code=400, 
            detail="Supply at least one prompt: points, box, or mask."
        )
    
    # Decode mask if provided
    binary_mask = None
    if has_mask:
        try:
            raw = base64.b64decode(req.mask_b64)
            img = Image.open(io.BytesIO(raw)).convert("L")
            binary_mask = np.array(img, dtype=np.uint8)
        except Exception as exc:
            raise HTTPException(status_code=400, detail=f"Could not decode mask: {exc}")
    
    # Call unified segmentation method
    try:
        mask = sam2.add_prompts(
            video_name=req.video_name,
            frame_idx=req.frame_idx,
            obj_id=req.obj_id,
            pos_points=req.positive_points or None,
            neg_points=req.negative_points or None,
            box=req.box,
            binary_mask=binary_mask,
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    
    return _save_mask_and_respond(
        mask, req.video_name, req.frame_idx, req.obj_id, req.obj_label
    )

@app.post("/propagate")
def propagate_endpoint(req: PropagateRequest):
    video_name = _safe_video_name(req.video_name)
    _require_video(video_name)
    
    if req.end_frame_idx is not None and req.end_frame_idx < req.start_frame_idx:
        raise HTTPException(status_code=400, detail="end_frame_idx must be >= start_frame_idx.")
    
    obj_labels = _get_object_labels_from_masks(video_name)
    print(obj_labels)
    try:
        total = sam2.propagate_and_save(
            video_name=video_name,
            out_dir=_mask_dir(video_name),
            start_frame_idx=req.start_frame_idx,
            end_frame_idx=req.end_frame_idx,
            obj_labels=obj_labels,
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    
    return {
        "masks_folder": f"/storage/masks/{video_name}",
        "start_frame_idx": req.start_frame_idx,
        "end_frame_idx": req.end_frame_idx,
        "total_masks_saved": total,
    }

# ── Frame/mask convenience endpoints ───────────────────────────────────────
@app.get("/videos/{video_name}/frames/{frame_idx}")
def get_frame(video_name: str, frame_idx: int):
    video_name = _safe_video_name(video_name)
    path = os.path.join(_frame_dir(video_name), f"{frame_idx:05d}.jpg")
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="Frame not found.")
    return FileResponse(path, media_type="image/jpeg")

@app.get("/videos/{video_name}/masks")
def list_masks(video_name: str):
    video_name = _safe_video_name(video_name)
    mdir = _mask_dir(video_name)
    if not os.path.isdir(mdir):
        return {"video_name": video_name, "masks": []}
    files = sorted(f for f in os.listdir(mdir) if f.endswith(".png"))
    return {
        "video_name": video_name,
        "masks": [f"/storage/masks/{video_name}/{f}" for f in files],
    }

@app.get("/videos/{video_name}/objects")
def get_objects(video_name: str):
    video_name = _safe_video_name(video_name)
    return {"objects": _get_object_labels_from_masks(video_name)}

@app.get("/videos/{video_name}/frames/{frame_idx}/polygons")
def get_mask_polygons(video_name: str, frame_idx: int, obj_id: int = 1):
    """Convert saved mask to polygon points."""
    video_name = _safe_video_name(video_name)
    mdir = _mask_dir(video_name)
    
    if not os.path.isdir(mdir):
        raise HTTPException(status_code=404, detail="No masks directory found.")
    
    # Find mask file
    prefix = f"{frame_idx:05d}_{obj_id}_"
    mask_file = next((f for f in os.listdir(mdir) if f.startswith(prefix) and f.endswith(".png")), None)
    if not mask_file:
        raise HTTPException(status_code=404, detail=f"No mask found for frame {frame_idx}, object {obj_id}.")
    
    mask_img = cv2.imread(os.path.join(mdir, mask_file), cv2.IMREAD_GRAYSCALE)
    if mask_img is None:
        raise HTTPException(status_code=500, detail="Could not read mask file.")
    
    # Process mask
    _, binary = cv2.threshold(mask_img, 127, 255, cv2.THRESH_BINARY)
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    binary = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, kernel)
    contours, _ = cv2.findContours(binary, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_TC89_KCOS)
    
    if not contours:
        return {"polygons": []}
    
    h, w = mask_img.shape[:2]
    epsilon = 0.005 * ((h ** 2 + w ** 2) ** 0.5)
    
    polygons = []
    for contour in contours:
        if cv2.contourArea(contour) < 50:
            continue
        approx = cv2.approxPolyDP(contour, epsilon, closed=True)
        pts = [{"x": int(pt[0][0]), "y": int(pt[0][1])} for pt in approx]
        if len(pts) >= 3:
            polygons.append(pts)
    
    return {"polygons": polygons}

@app.delete("/videos/{video_name}")
def delete_video(video_name: str):
    import shutil
    video_name = _safe_video_name(video_name)
    _require_video(video_name)
    
    sam2.clear_video(video_name)
    
    for path in (_video_path(video_name), _frame_dir(video_name), _mask_dir(video_name)):
        if os.path.isfile(path):
            os.remove(path)
        elif os.path.isdir(path):
            shutil.rmtree(path)
    
    return {"deleted": video_name}

@app.post("/render-masked-video")
def render_masked_video_endpoint(req: RenderMaskedVideoRequest):
    video_name = _safe_video_name(req.video_name)
    _require_video(video_name)
    
    fdir = _frame_dir(video_name)
    mdir = _mask_dir(video_name)
    
    if not os.path.isdir(fdir) or not os.listdir(fdir):
        raise HTTPException(status_code=404, detail="Frames not found.")
    if not os.path.isdir(mdir) or not os.listdir(mdir):
        raise HTTPException(status_code=404, detail="No masks found.")
    
    # Build BGR palette
    req_palette = {}
    for key, c in req.obj_colors.items():
        try:
            req_palette[int(key)] = (c.b, c.g, c.r)
        except ValueError:
            pass
    
    cap = cv2.VideoCapture(_video_path(video_name))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    cap.release()
    
    frame_files = sorted(f for f in os.listdir(fdir) if f.endswith(".jpg"))
    if not frame_files:
        raise HTTPException(status_code=404, detail="No frames found.")
    
    first_frame = cv2.imread(os.path.join(fdir, frame_files[0]))
    h, w = first_frame.shape[:2]
    
    out_path = os.path.join(VIDEO_DIR, f"{video_name}_masked.mp4")
    
    # Use mp4v codec (software-based, widely available)
    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    writer = cv2.VideoWriter(out_path, fourcc, fps, (w, h))
    
    # Verify writer opened successfully
    if not writer.isOpened():
        raise HTTPException(status_code=500, detail="Failed to initialize video writer")
    
    # Collect all object IDs
    all_obj_ids = set()
    for fname in os.listdir(mdir):
        parsed = _parse_mask_filename(fname)
        if parsed:
            all_obj_ids.add(parsed[1])
    
    for fname in frame_files:
        frame_idx = int(fname.replace(".jpg", ""))
        frame = cv2.imread(os.path.join(fdir, fname))
        if frame is None:
            continue
        
        overlay = frame.copy()
        
        for obj_id in sorted(all_obj_ids):
            mask_pattern = f"{frame_idx:05d}_{obj_id}_"
            mask_file = next((mf for mf in os.listdir(mdir) 
                            if mf.startswith(mask_pattern) and mf.endswith('.png')), None)
            if not mask_file:
                continue
            
            mask_img = cv2.imread(os.path.join(mdir, mask_file), cv2.IMREAD_GRAYSCALE)
            if mask_img is None:
                continue
            
            if mask_img.shape[:2] != (h, w):
                mask_img = cv2.resize(mask_img, (w, h), interpolation=cv2.INTER_NEAREST)
            
            binary = mask_img > 127
            color_bgr = _obj_color_bgr(obj_id, req_palette)
            color_arr = np.array(color_bgr, dtype=np.uint8)
            
            overlay[binary] = (overlay[binary] * (1 - req.alpha) + color_arr * req.alpha).astype(np.uint8)
            
            contours, _ = cv2.findContours(mask_img, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            cv2.drawContours(overlay, contours, -1, color_bgr, 2)
        
        writer.write(overlay)
    
    writer.release()
    
    return {
        "masked_video_name": f"{video_name}_masked",
        "video_url": f"/videos/{video_name}_masked/stream",
    }