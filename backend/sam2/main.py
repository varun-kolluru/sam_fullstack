"""
main.py – SAM-2 Video Segmentation API
=======================================

Directory layout
----------------
storage/
  videos/<video_name>.mp4
  frames/<video_name>/00000.jpg …
  masks/<video_name>/00000_<obj_id>.png …
"""

from __future__ import annotations

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
MASK_DIR = os.path.join(BASE_DIR, "masks")

for _d in (VIDEO_DIR, FRAME_DIR, MASK_DIR):
    os.makedirs(_d, exist_ok=True)

app.mount("/storage", StaticFiles(directory=BASE_DIR), name="storage")

sam2 = SAM2Service()

# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _safe_video_name(raw: str) -> str:
    """Strip path separators so the name is safe to use as a directory name."""
    return os.path.basename(raw).strip()


def _video_path(name: str) -> str:
    return os.path.join(VIDEO_DIR, f"{name}.mp4")


def _frame_dir(name: str) -> str:
    return os.path.join(FRAME_DIR, name)


def _mask_dir(name: str) -> str:
    return os.path.join(MASK_DIR, name)


def _extract_frames(video_path: str, out_dir: str) -> tuple[int, float]:
    """Extract every frame from *video_path* into *out_dir* as JPEG files."""
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


class SelectVideoRequest(BaseModel):
    video_name: str


class SegmentPointsRequest(BaseModel):
    video_name: str
    frame_idx: int
    obj_id: int = Field(1, description="Object ID – use different IDs for different objects.")
    positive_points: list[list[int]] = Field(
        default_factory=list,
        description="List of [x, y] positive click coordinates.",
    )
    negative_points: list[list[int]] = Field(
        default_factory=list,
        description="List of [x, y] negative click coordinates.",
    )
    box: list[int] | None = Field(
        None,
        description="Bounding box [x_min, y_min, x_max, y_max]. "
        "Can be combined with point clicks.",
    )


class SegmentMaskRequest(BaseModel):
    video_name: str
    frame_idx: int
    obj_id: int = Field(1, description="Object ID.")
    mask_b64: str = Field(
        ...,
        description="Base-64 encoded binary mask image (PNG/JPEG). "
        "Non-zero pixels are treated as foreground.",
    )


class PropagateRequest(BaseModel):
    video_name: str
    start_frame_idx: int = 0
    end_frame_idx: int | None = None


def _save_mask_and_respond(
    mask: np.ndarray, video_name: str, frame_idx: int, obj_id: int
) -> dict:
    """Persist the mask PNG and return the HTTP response dict."""
    mdir = _mask_dir(video_name)
    os.makedirs(mdir, exist_ok=True)
    fname = f"{frame_idx:05d}_{obj_id}.png"
    path = os.path.join(mdir, fname)
    Image.fromarray(mask).save(path)
    return {"mask_path": f"/storage/masks/{video_name}/{fname}"}

# ---------------------------------------------------------------------------
# Video management endpoints
# ---------------------------------------------------------------------------


@app.get("/videos", summary="List all stored video names")
def list_videos():
    """Return names of every video that has been uploaded."""
    names = [
        f[:-4]  # strip .mp4
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

    # Re-read fps from the saved video file
    cap = cv2.VideoCapture(_video_path(video_name))
    fps = cap.get(cv2.CAP_PROP_FPS)
    cap.release()

    return {"video_name": video_name, "fps": fps, "total_frames": total_frames}


@app.post("/upload-video", summary="Upload a new video")
async def upload_video(
    video: UploadFile = File(...),
    name: str = Query(
        "",
        description="Optional custom name for the video (no extension). "
        "A UUID is generated when left blank.",
    ),
):
    """
    Upload an MP4 video.

    * If *name* is provided and a video with that name already exists the
      request is rejected (409 Conflict).
    * If *name* is blank a UUID is generated automatically.
    * Frames are extracted immediately and SAM-2 is initialised for the video.
    """
    # Determine and validate the name
    if name:
        video_name = _safe_video_name(name)
        if not video_name:
            raise HTTPException(status_code=400, detail="Provided name is invalid.")
        if os.path.exists(_video_path(video_name)):
            raise HTTPException(
                status_code=409,
                detail=f"A video named '{video_name}' already exists. "
                "Choose a different name or select the existing video.",
            )
    else:
        video_name = str(uuid.uuid4())

    vpath = _video_path(video_name)
    fdir = _frame_dir(video_name)

    # Save the uploaded file
    with open(vpath, "wb") as fh:
        fh.write(await video.read())

    # Extract frames
    total_frames, fps = _extract_frames(vpath, fdir)
    if total_frames == 0:
        os.remove(vpath)
        raise HTTPException(status_code=422, detail="Could not extract frames from the video.")

    # Initialise SAM-2 inference state
    sam2.init_video(video_name, fdir)

    return {
        "video_name": video_name,
        "fps": fps,
        "total_frames": total_frames,
    }


@app.post("/select-video", summary="Select an existing video and initialise SAM-2")
def select_video(body: SelectVideoRequest):
    """
    Select a previously uploaded video.  This reinitialises the SAM-2
    inference state so the user can start a fresh segmentation session.
    """
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
    """
    Provide positive / negative point clicks and / or a bounding box to segment
    an object on *frame_idx*.

    At least one of *positive_points*, *negative_points*, or *box* must be supplied.
    """
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

    return _save_mask_and_respond(mask, req.video_name, req.frame_idx, req.obj_id)


@app.post("/segment-frame/mask", summary="Segment using a binary mask prompt")
def segment_frame_mask(req: SegmentMaskRequest):
    """
    Provide an existing binary mask (base-64 encoded image) as the prompt.
    Non-zero pixels are treated as foreground.
    """
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

    return _save_mask_and_respond(mask, req.video_name, req.frame_idx, req.obj_id)


@app.post("/propagate", summary="Propagate segmentation masks through the entire video")
def propagate(req: PropagateRequest):
    """
    Propagate the current prompts through every frame of the video.

    Masks are saved under:
        storage/masks/<video_name>/<frame_idx:05d>_<obj_id>.png

    Returns the masks folder path and total masks saved.
    """
    video_name = _safe_video_name(req.video_name)
    _require_video(video_name)

    if req.end_frame_idx is not None and req.end_frame_idx < req.start_frame_idx:
        raise HTTPException(status_code=400,detail="end_frame_idx must be >= start_frame_idx.")

    out_dir = _mask_dir(video_name)
    print(req.start_frame_idx,req.end_frame_idx)
    try:
        total = sam2.propagate_and_save(
            video_name=video_name,
            out_dir=out_dir,
            start_frame_idx=req.start_frame_idx,
            end_frame_idx=req.end_frame_idx
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


@app.get(
    "/videos/{video_name}/masks",
    summary="List all saved mask filenames for a video",
)
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
# mask video render endpoint
# ---------------------------------------------------------------------------

class RenderMaskedVideoRequest(BaseModel):
    video_name: str
    alpha: float = Field(0.45, description="Mask overlay opacity (0–1).")

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

    mask_color = np.array([29, 158, 117], dtype=np.uint8)  # BGR teal

    for fname in frame_files:
        frame_idx = int(fname.replace(".jpg", ""))
        frame = cv2.imread(os.path.join(fdir, fname))
        if frame is None:
            continue

        mask_path = os.path.join(mdir, f"{frame_idx:05d}_1.png")
        if os.path.exists(mask_path):
            mask_img = cv2.imread(mask_path, cv2.IMREAD_GRAYSCALE)
            if mask_img is not None:
                if mask_img.shape[:2] != (h, w):
                    mask_img = cv2.resize(mask_img, (w, h), interpolation=cv2.INTER_NEAREST)
                binary = mask_img > 127
                overlay = frame.copy()
                overlay[binary] = (
                    frame[binary] * (1 - req.alpha) + mask_color * req.alpha
                ).astype(np.uint8)
                contours, _ = cv2.findContours(mask_img, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
                cv2.drawContours(overlay, contours, -1, (29, 200, 117), 2)
                frame = overlay

        writer.write(frame)

    writer.release()

    masked_video_name = f"{video_name}_masked"
    return {
        "masked_video_name": masked_video_name,
        "video_url": f"/videos/{masked_video_name}/stream",
    }