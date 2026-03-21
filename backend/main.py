from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from fastapi.staticfiles import StaticFiles
import os, uuid, cv2
from sam2_service import SAM2Service
from PIL import Image
import numpy as np
import torch
from fastapi.responses import Response

app = FastAPI()

# Serve storage folder
app.mount("/storage", StaticFiles(directory="storage"), name="storage")

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
VIDMASK_DIR = os.path.join(BASE_DIR, "vidmasks")

os.makedirs(VIDEO_DIR, exist_ok=True)
os.makedirs(FRAME_DIR, exist_ok=True)
os.makedirs(MASK_DIR, exist_ok=True)
os.makedirs(VIDMASK_DIR, exist_ok=True)


sam2_service = SAM2Service()


# -----------------------------
# Helper: Extract Frames + FPS
# -----------------------------
def extract_frames(video_path: str, out_dir: str):
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


# -----------------------------
# Upload Video
# -----------------------------
@app.post("/upload-video")
async def upload_video(video: UploadFile = File(...)):
    video_id = str(uuid.uuid4())
    video_path = os.path.join(VIDEO_DIR, f"{video_id}.mp4")
    frame_dir = os.path.join(FRAME_DIR, video_id)
    os.makedirs(frame_dir, exist_ok=True)

    with open(video_path, "wb") as f:
        f.write(await video.read())

    total_frames, fps = extract_frames(video_path, frame_dir)

    if not os.path.exists(frame_dir):
        raise HTTPException(404, "Frames not found")

    sam2_service.init_video(video_id, frame_dir)
    print("status: initialized")

    return {
        "video_id": video_id,
        "fps": fps,
        "total_frames": total_frames
    }


# -----------------------------
# Segment Frame
# -----------------------------
class SegmentFrameRequest(BaseModel):
    video_id: str
    frame_idx: int
    positive_points: list[list[int]] = []
    negative_points: list[list[int]] = []
    boxes: list[list[int]] = []
    polygon: list[list[int]] = []

@app.post("/segment-frame")
def segment_frame(req: SegmentFrameRequest):

    if (
        len(req.positive_points) == 0
        and len(req.negative_points) == 0
        and len(req.boxes) == 0
    ):
        raise HTTPException(400, "No prompt given")

    sam2_service.segment(
        video_id=req.video_id,
        frame_idx=req.frame_idx,
        positive_points=req.positive_points,
        negative_points=req.negative_points,
        boxes=req.boxes,
        polygon=req.polygon,
    )

    return {"status": "ok"}

# @app.post("/segment-frame")
# def segment_frame(req: SegmentFrameRequest):

#     # ---------- validate prompt ----------
#     if (
#         len(req.positive_points) == 0
#         and len(req.negative_points) == 0
#         and len(req.boxes) == 0
#     ):
#         raise HTTPException(
#             status_code=400,
#             detail="No prompt given (points or box required)",
#         )

#     try:
#         mask = sam2_service.segment(
#             video_id=req.video_id,
#             frame_idx=req.frame_idx,
#             positive_points=req.positive_points,
#             negative_points=req.negative_points,
#             boxes=req.boxes,
#             polygon=req.polygon,   # ignored inside service for now
#         )

#     except RuntimeError as e:
#         print("SAM2 ERROR:", e)
#         raise HTTPException(status_code=400, detail=str(e))

#     # ---------- save mask ----------
#     out_dir = os.path.join(MASK_DIR, req.video_id)
#     os.makedirs(out_dir, exist_ok=True)

#     out_path = os.path.join(
#         out_dir,
#         f"{req.frame_idx:05d}.png"
#     )

#     Image.fromarray(mask).save(out_path)

#     return {
#         "mask_path": f"/storage/masks/{req.video_id}/{req.frame_idx:05d}.png"
#     }

# -----------------------------
# Propagate Video Mask
# -----------------------------
class PropagateRequest(BaseModel):
    video_id: str

@app.post("/propagate-video")
def propagate_video(req: PropagateRequest):

    video_id = req.video_id

    if video_id not in sam2_service.states:
        raise HTTPException(400, "Video not initialized")

    sam2_service.propagate(video_id)

    return {
        "status": "tracking_done"
    }
# @app.post("/propagate-video")
# def propagate_video(req: PropagateRequest):

#     video_id = req.video_id

#     if video_id not in sam2_service.states:
#         raise HTTPException(400, "Video not initialized")

#     video_segments = sam2_service.propagate(video_id)

#     return {
#         "total_frames": len(video_segments)
#     }
# @app.post("/propagate-video")
# def propagate_video(req: PropagateRequest):

#     video_id = req.video_id

#     if video_id not in sam2_service.states:
#         raise RuntimeError("Video not initialized. Call init_video first.")

#     predictor = sam2_service.predictors[video_id]
#     inference_state = sam2_service.states[video_id]

#     out_dir = os.path.join("storage/vidmasks", video_id)
#     os.makedirs(out_dir, exist_ok=True)

#     total_frames = 0

#     with torch.inference_mode():

#         for out_frame_idx, out_obj_ids, out_mask_logits in predictor.propagate_in_video(
#             inference_state
#         ):

#             mask = (out_mask_logits[0] > 0).cpu().numpy().astype("uint8") * 255
#             mask = np.squeeze(mask)

#             out_path = os.path.join(out_dir, f"{out_frame_idx:05d}.png")

#             Image.fromarray(mask).save(out_path)

#             total_frames += 1

#     return {
#         "masks_folder": f"/storage/vidmasks/{video_id}",
#         "total_frames": total_frames
#     }

@app.get("/mask")
def get_mask(video_id: str, frame_idx: int):

    mask = sam2_service.mask_cache.get(video_id, {}).get(frame_idx)

    if mask is None:
        raise HTTPException(404, "Mask not ready")

    _, png = cv2.imencode(".png", mask)

    return Response(
        content=png.tobytes(),
        media_type="image/png"
    )