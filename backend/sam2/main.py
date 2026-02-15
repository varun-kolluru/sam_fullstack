from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from fastapi.staticfiles import StaticFiles
import os, uuid, cv2
from sam2_service import SAM2Service
from PIL import Image

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

os.makedirs(VIDEO_DIR, exist_ok=True)
os.makedirs(FRAME_DIR, exist_ok=True)
os.makedirs(MASK_DIR, exist_ok=True)

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
    positive_points: list[list[int]]
    negative_points: list[list[int]]
    boxes: list[list[int]] = []
    polygon: list[list[int]] = []


@app.post("/segment-frame")
def segment_frame(req: SegmentFrameRequest):
    try:
        mask = sam2_service.add_points(
            req.video_id,
            req.frame_idx,
            req.positive_points,
            req.negative_points
        )
        print(req.positive_points)
    except RuntimeError as e:
        print("SAM2 ERROR:", e)
        raise HTTPException(400, str(e))

    out_dir = os.path.join(MASK_DIR, req.video_id)
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, f"{req.frame_idx:05d}.png")

    Image.fromarray(mask).save(out_path)

    return {
        "mask_path": f"/storage/masks/{req.video_id}/{req.frame_idx:05d}.png"
    }


# -----------------------------
# Propagate Video Mask
# -----------------------------
class PropagateRequest(BaseModel):
    video_id: str


@app.post("/propagate-video-mask")
def propagate_video_mask(req: PropagateRequest):
    video_id = req.video_id

    out_dir = os.path.join(MASK_DIR, video_id)

    try:
        total_frames = sam2_service.propagate_and_save(video_id, out_dir)
    except RuntimeError as e:
        raise HTTPException(400, str(e))

    return {
        "masks_folder": f"/storage/masks/{video_id}",
        "total_frames": total_frames
    }
