"""
main.py – SAM-2 Video Segmentation API
=======================================

Directory layout
----------------
storage/
  videos/<video_name>.mp4
  frames/<video_name>/00000.jpg …
  masks/<video_name>/00000_<obj_id>_<label>.png …
"""

from __future__ import annotations

import base64
import io
import os
import re
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

# ---------------------------------------------------------------------------
# App setup
# ---------------------------------------------------------------------------

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
MASK_DIR  = os.path.join(BASE_DIR, "masks")

for _d in (VIDEO_DIR, FRAME_DIR, MASK_DIR):
    os.makedirs(_d, exist_ok=True)

app.mount("/storage", StaticFiles(directory=BASE_DIR), name="storage")

sam2 = SAM2Service()

# ---------------------------------------------------------------------------
# Default palette – BGR colours used when the caller doesn't supply one
# ---------------------------------------------------------------------------

_DEFAULT_PALETTE_BGR: list[tuple[int, int, int]] = [
    (117, 158,  29),   # obj 1 – teal-green
    ( 29,  99, 235),   # obj 2 – blue
    (  0, 165, 255),   # obj 3 – orange
    (  0,   0, 220),   # obj 4 – red
    (128,   0, 128),   # obj 5 – purple
    (  0, 128, 128),   # obj 6 – olive
    (203, 192, 255),   # obj 7 – pink
    ( 42, 255, 255),   # obj 8 – yellow
]

def _obj_color_bgr(obj_id: int, palette: dict[int, tuple[int, int, int]] | None = None) -> tuple[int, int, int]:
    if palette and obj_id in palette:
        return palette[obj_id]
    idx = (obj_id - 1) % len(_DEFAULT_PALETTE_BGR)
    return _DEFAULT_PALETTE_BGR[idx]

# ---------------------------------------------------------------------------
# Label and filename helpers
# ---------------------------------------------------------------------------

def _sanitize_label(label: str) -> str:
    """Sanitize label for use in filename."""
    # Replace spaces and special chars with underscore
    safe = "".join(c if c.isalnum() or c in ('-', '_') else '_' for c in label)
    # Limit length
    return safe[:50] if safe else "object"


def _parse_mask_filename(filename: str) -> tuple[int, int, str] | None:
    """
    Parse mask filename to extract frame_idx, obj_id, and label.
    Expected format: {frame_idx:05d}_{obj_id}_{label}.png
    Returns: (frame_idx, obj_id, label) or None if parsing fails
    """
    if not filename.endswith('.png'):
        return None
    
    # Remove .png extension
    name = filename[:-4]
    
    # Split by underscore
    parts = name.split('_', 2)  # Split into max 3 parts
    
    if len(parts) >= 2:
        try:
            frame_idx = int(parts[0])
            obj_id = int(parts[1])
            label = parts[2] if len(parts) > 2 else f"Object {obj_id}"
            return (frame_idx, obj_id, label)
        except ValueError:
            pass
    
    return None


def _get_object_labels_from_masks(video_name: str) -> dict[str, str]:
    """
    Extract object labels from mask filenames in the masks directory.
    Returns: dict mapping obj_id (as string) -> label
    """
    mdir = _mask_dir(video_name)
    if not os.path.isdir(mdir):
        return {}
    
    labels_map: dict[str, str] = {}
    
    for filename in os.listdir(mdir):
        parsed = _parse_mask_filename(filename)
        if parsed:
            _, obj_id, label = parsed
            # Store the most recent label for each obj_id
            labels_map[str(obj_id)] = label
    
    return labels_map


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _safe_video_name(raw: str) -> str:
    return os.path.basename(raw).strip()


def _video_path(name: str) -> str:
    return os.path.join(VIDEO_DIR, f"{name}.mp4")


def _frame_dir(name: str) -> str:
    return os.path.join(FRAME_DIR, name)


def _mask_dir(name: str) -> str:
    return os.path.join(MASK_DIR, name)


def _extract_frames(video_path: str, out_dir: str) -> tuple[int, float]:
    os.makedirs(out_dir, exist_ok=True)
    cap = cv2.VideoCapture(video_path)
    fps = cap.get(cv2.CAP_PROP_FPS)
    idx = 0
    while True:
        ret, frame = cap.read()
        if not ret:
            break
        cv2.imwrite(os.path.join(out_dir, f"{idx:05d}.jpg"), frame)
        idx += 1
    cap.release()
    return idx, fps


def _require_video(name: str) -> None:
    if not os.path.exists(_video_path(name)):
        raise HTTPException(status_code=404, detail=f"Video '{name}' not found.")


def _require_frames(name: str) -> None:
    fd = _frame_dir(name)
    if not os.path.isdir(fd) or not os.listdir(fd):
        raise HTTPException(
            status_code=404,
            detail=f"Frames for video '{name}' not found. Upload the video first.",
        )


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class SelectVideoRequest(BaseModel):
    video_name: str


class SegmentPointsRequest(BaseModel):
    video_name: str
    frame_idx: int
    obj_id: int = Field(1, description="Object ID – use different IDs for different objects.")
    obj_label: str = Field("Object", description="Object label for display.")
    positive_points: list[list[int]] = Field(default_factory=list)
    negative_points: list[list[int]] = Field(default_factory=list)
    box: list[int] | None = None


class SegmentMaskRequest(BaseModel):
    video_name: str
    frame_idx: int
    obj_id: int = Field(1, description="Object ID.")
    obj_label: str = Field("Object", description="Object label for display.")
    mask_b64: str


class PropagateRequest(BaseModel):
    video_name: str
    start_frame_idx: int = 0
    end_frame_idx: int | None = None


class ObjColorEntry(BaseModel):
    """RGB colour for one object (0-255 per channel)."""
    r: int
    g: int
    b: int


class RenderMaskedVideoRequest(BaseModel):
    video_name: str
    alpha: float = Field(0.45, description="Mask overlay opacity (0–1).")
    # obj_id → colour mapping; keys are strings because JSON keys are always strings
    obj_colors: dict[str, ObjColorEntry] = Field(
        default_factory=dict,
        description="Per-object RGB colours. Key is obj_id as a string.",
    )


# ---------------------------------------------------------------------------
# Internal helper
# ---------------------------------------------------------------------------

def _save_mask_and_respond(
    mask: np.ndarray, video_name: str, frame_idx: int, obj_id: int, obj_label: str
) -> dict:
    """
    Save mask with label in filename.
    Filename format: {frame_idx:05d}_{obj_id}_{sanitized_label}.png
    """
    mdir = _mask_dir(video_name)
    os.makedirs(mdir, exist_ok=True)
    safe_label = _sanitize_label(obj_label)
    fname = f"{frame_idx:05d}_{obj_id}_{safe_label}.png"
    path = os.path.join(mdir, fname)
    Image.fromarray(mask).save(path)
    return {"mask_path": f"/storage/masks/{video_name}/{fname}"}


# ---------------------------------------------------------------------------
# Video management endpoints
# ---------------------------------------------------------------------------

@app.get("/videos", summary="List all stored video names")
def list_videos():
    names = [
        f[:-4]
        for f in os.listdir(VIDEO_DIR)
        if f.endswith(".mp4") and not f.endswith("_masked.mp4")
    ]
    return {"videos": names}


@app.get("/videos/{video_name}/stream", summary="Stream / download a stored video")
def stream_video(video_name: str):
    video_name = _safe_video_name(video_name)
    path = _video_path(video_name)
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail=f"Video '{video_name}' not found.")
    return FileResponse(path, media_type="video/mp4")


@app.get("/videos/{video_name}/info", summary="Metadata for a stored video")
def video_info(video_name: str):
    video_name = _safe_video_name(video_name)
    _require_video(video_name)
    _require_frames(video_name)

    fd = _frame_dir(video_name)
    frames = sorted(f for f in os.listdir(fd) if f.endswith(".jpg"))
    total_frames = len(frames)

    cap = cv2.VideoCapture(_video_path(video_name))
    fps = cap.get(cv2.CAP_PROP_FPS)
    cap.release()

    return {"video_name": video_name, "fps": fps, "total_frames": total_frames}


@app.post("/upload-video", summary="Upload a new video")
async def upload_video(
    video: UploadFile = File(...),
    name: str = Query(""),
):
    if name:
        video_name = _safe_video_name(name)
        if not video_name:
            raise HTTPException(status_code=400, detail="Provided name is invalid.")
        if os.path.exists(_video_path(video_name)):
            raise HTTPException(
                status_code=409,
                detail=f"Video '{video_name}' already exists. Delete it first or choose a different name.",
            )
    else:
        video_name = _safe_video_name(video.filename or f"video_{uuid.uuid4().hex[:8]}")

    vpath = _video_path(video_name)
    with open(vpath, "wb") as f:
        f.write(await video.read())

    fdir = _frame_dir(video_name)
    try:
        total_frames, fps = _extract_frames(vpath, fdir)
    except Exception:
        os.remove(vpath)
        raise HTTPException(status_code=422, detail="Could not extract frames from the video.")

    sam2.init_video(video_name, fdir)

    return {"video_name": video_name, "fps": fps, "total_frames": total_frames}


@app.post("/select-video", summary="Select an existing video and initialise SAM-2")
def select_video(body: SelectVideoRequest):
    video_name = _safe_video_name(body.video_name)
    _require_video(video_name)
    _require_frames(video_name)

    sam2.init_video(video_name, _frame_dir(video_name))

    cap = cv2.VideoCapture(_video_path(video_name))
    fps = cap.get(cv2.CAP_PROP_FPS)
    cap.release()

    fdir = _frame_dir(video_name)
    total_frames = len([f for f in os.listdir(fdir) if f.endswith(".jpg")])

    return {"video_name": video_name, "fps": fps, "total_frames": total_frames}


# ---------------------------------------------------------------------------
# Segmentation endpoints
# ---------------------------------------------------------------------------

@app.post("/segment-frame/points", summary="Segment using point clicks and/or a bounding box")
def segment_frame_points(req: SegmentPointsRequest):
    if not req.positive_points and not req.negative_points and not req.box:
        raise HTTPException(
            status_code=400,
            detail="Supply at least one positive point, negative point, or box.",
        )
    try:
        mask = sam2.add_points_or_box(
            video_name=req.video_name,
            frame_idx=req.frame_idx,
            obj_id=req.obj_id,
            pos_points=req.positive_points or None,
            neg_points=req.negative_points or None,
            box=req.box,
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    return _save_mask_and_respond(mask, req.video_name, req.frame_idx, req.obj_id, req.obj_label)


@app.post("/segment-frame/mask", summary="Segment using a binary mask prompt")
def segment_frame_mask(req: SegmentMaskRequest):
    try:
        raw = base64.b64decode(req.mask_b64)
        img = Image.open(io.BytesIO(raw)).convert("L")
        binary_mask = np.array(img, dtype=np.uint8)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Could not decode mask image: {exc}")

    try:
        mask = sam2.add_mask(
            video_name=req.video_name,
            frame_idx=req.frame_idx,
            obj_id=req.obj_id,
            binary_mask=binary_mask,
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    return _save_mask_and_respond(mask, req.video_name, req.frame_idx, req.obj_id, req.obj_label)


@app.post("/propagate", summary="Propagate segmentation masks through the video")
def propagate(req: PropagateRequest):
    video_name = _safe_video_name(req.video_name)
    _require_video(video_name)

    if req.end_frame_idx is not None and req.end_frame_idx < req.start_frame_idx:
        raise HTTPException(status_code=400, detail="end_frame_idx must be >= start_frame_idx.")

    out_dir = _mask_dir(video_name)
    # Get existing labels from mask filenames
    obj_labels = _get_object_labels_from_masks(video_name)
    
    print(req.start_frame_idx, req.end_frame_idx)
    try:
        total = sam2.propagate_and_save(
            video_name=video_name,
            out_dir=out_dir,
            start_frame_idx=req.start_frame_idx,
            end_frame_idx=req.end_frame_idx,
            obj_labels=obj_labels,  # Pass labels to SAM2Service
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    return {
        "masks_folder": f"/storage/masks/{video_name}",
        "start_frame_idx": req.start_frame_idx,
        "end_frame_idx": req.end_frame_idx,
        "total_masks_saved": total,
    }


# ---------------------------------------------------------------------------
# Frame / mask convenience endpoints
# ---------------------------------------------------------------------------

@app.get("/videos/{video_name}/frames/{frame_idx}", summary="Get a specific frame image")
def get_frame(video_name: str, frame_idx: int):
    video_name = _safe_video_name(video_name)
    path = os.path.join(_frame_dir(video_name), f"{frame_idx:05d}.jpg")
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="Frame not found.")
    return FileResponse(path, media_type="image/jpeg")


@app.get("/videos/{video_name}/masks", summary="List all saved mask filenames for a video")
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


@app.get("/videos/{video_name}/objects", summary="Get object labels from mask filenames")
def get_objects(video_name: str):
    """
    Extract and return object labels from mask filenames.
    Response: { "objects": { "1": "Object_1", "2": "Person", ... } }
    """
    video_name = _safe_video_name(video_name)
    labels_map = _get_object_labels_from_masks(video_name)
    return {"objects": labels_map}


@app.get(
    "/videos/{video_name}/frames/{frame_idx}/polygons",
    summary="Convert the saved mask for a frame+object into draggable polygon points",
)
def get_mask_polygons(video_name: str, frame_idx: int, obj_id: int = 1):
    """
    Reads the mask PNG saved for (video_name, frame_idx, obj_id) and returns
    the outer contour(s) as a list of polygon point arrays.

    Each polygon is a list of {x, y} objects in **video-pixel** coordinates,
    already simplified with the Douglas-Peucker algorithm so the frontend
    gets a manageable number of draggable vertices.

    Response shape:
        { "polygons": [ [ {"x": int, "y": int}, … ], … ] }
    """
    video_name = _safe_video_name(video_name)
    mdir = _mask_dir(video_name)

    if not os.path.isdir(mdir):
        raise HTTPException(status_code=404, detail="No masks directory found for this video.")

    # Find the mask file matching frame_idx and obj_id
    prefix = f"{frame_idx:05d}_{obj_id}_"
    mask_file = next(
        (f for f in os.listdir(mdir) if f.startswith(prefix) and f.endswith(".png")),
        None,
    )
    if mask_file is None:
        raise HTTPException(
            status_code=404,
            detail=f"No mask found for frame {frame_idx}, object {obj_id}. "
                   "Run segmentation first.",
        )

    mask_path = os.path.join(mdir, mask_file)
    mask_img = cv2.imread(mask_path, cv2.IMREAD_GRAYSCALE)
    if mask_img is None:
        raise HTTPException(status_code=500, detail="Could not read mask file.")

    # Threshold to binary
    _, binary = cv2.threshold(mask_img, 127, 255, cv2.THRESH_BINARY)

    # Optional: close small holes before contouring
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    binary = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, kernel)

    # Find external contours only
    contours, _ = cv2.findContours(binary, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_TC89_KCOS)

    if not contours:
        return {"polygons": []}

    h, w = mask_img.shape[:2]
    # Epsilon for Douglas-Peucker: ~0.5 % of the image diagonal gives good simplification
    diag = (h ** 2 + w ** 2) ** 0.5
    epsilon = 0.005 * diag

    polygons: list[list[dict]] = []
    for contour in contours:
        # Skip tiny noise contours (< 50 px area)
        if cv2.contourArea(contour) < 50:
            continue
        approx = cv2.approxPolyDP(contour, epsilon, closed=True)
        # approx shape: (N, 1, 2)
        pts = [{"x": int(pt[0][0]), "y": int(pt[0][1])} for pt in approx]
        if len(pts) >= 3:
            polygons.append(pts)

    return {"polygons": polygons}


@app.delete("/videos/{video_name}", summary="Delete a video and all associated data")
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


# ---------------------------------------------------------------------------
# Masked video render endpoint  (multi-object aware)
# ---------------------------------------------------------------------------

@app.post("/render-masked-video", summary="Composite masks onto video and render a new MP4")
def render_masked_video(req: RenderMaskedVideoRequest):
    video_name = _safe_video_name(req.video_name)
    _require_video(video_name)

    fdir = _frame_dir(video_name)
    mdir = _mask_dir(video_name)

    if not os.path.isdir(fdir) or not os.listdir(fdir):
        raise HTTPException(status_code=404, detail="Frames not found.")
    if not os.path.isdir(mdir) or not os.listdir(mdir):
        raise HTTPException(status_code=404, detail="No masks found. Run propagation first.")

    # Build int-keyed BGR palette from the request (colours arrive as RGB)
    req_palette: dict[int, tuple[int, int, int]] = {}
    for key, c in req.obj_colors.items():
        try:
            oid = int(key)
            req_palette[oid] = (c.b, c.g, c.r)   # RGB → BGR for OpenCV
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
    fourcc = cv2.VideoWriter_fourcc(*"avc1")
    writer = cv2.VideoWriter(out_path, fourcc, fps, (w, h))

    # Collect all obj_ids present in the mask directory
    all_obj_ids: set[int] = set()
    for fname in os.listdir(mdir):
        parsed = _parse_mask_filename(fname)
        if parsed:
            _, obj_id, _ = parsed
            all_obj_ids.add(obj_id)

    for fname in frame_files:
        frame_idx = int(fname.replace(".jpg", ""))
        frame = cv2.imread(os.path.join(fdir, fname))
        if frame is None:
            continue

        overlay = frame.copy()

        for obj_id in sorted(all_obj_ids):
            # Find mask file for this frame and obj_id
            # Pattern: {frame_idx:05d}_{obj_id}_*.png
            mask_pattern = f"{frame_idx:05d}_{obj_id}_"
            mask_file = None
            for mf in os.listdir(mdir):
                if mf.startswith(mask_pattern) and mf.endswith('.png'):
                    mask_file = mf
                    break
            
            if not mask_file:
                continue

            mask_path = os.path.join(mdir, mask_file)
            mask_img = cv2.imread(mask_path, cv2.IMREAD_GRAYSCALE)
            if mask_img is None:
                continue

            if mask_img.shape[:2] != (h, w):
                mask_img = cv2.resize(mask_img, (w, h), interpolation=cv2.INTER_NEAREST)

            binary = mask_img > 127
            color_bgr = _obj_color_bgr(obj_id, req_palette)
            color_arr = np.array(color_bgr, dtype=np.uint8)

            # Blend colour into the overlay (accumulate over objects)
            overlay[binary] = (
                overlay[binary] * (1 - req.alpha) + color_arr * req.alpha
            ).astype(np.uint8)

            # Draw contour
            contours, _ = cv2.findContours(mask_img, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            cv2.drawContours(overlay, contours, -1, color_bgr, 2)

        writer.write(overlay)

    writer.release()

    masked_video_name = f"{video_name}_masked"
    return {
        "masked_video_name": masked_video_name,
        "video_url": f"/videos/{masked_video_name}/stream",
    }