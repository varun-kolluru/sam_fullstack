# backend/sam2_service.py
import os
import torch
import numpy as np
from PIL import Image
from sam2.build_sam import build_sam2_video_predictor

class SAM2Service:
    def __init__(self, model_type="sam2"):
        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        self.model_type = model_type
        
        self.cfg = "configs/sam2.1/sam2.1_hiera_t.yaml"
        self.ckpt = "checkpoints/sam2.1_hiera_tiny.pt"

        self.predictors = {}
        self.states = {}

    def _load_predictor(self, video_id: str):
        if video_id not in self.predictors:
            # Local loading using build_sam2_video_predictor
            predictor = build_sam2_video_predictor(
                config_file=self.cfg,
                ckpt_path=self.ckpt,
                device=self.device,
                vos_optimized=False
            )
            self.predictors[video_id] = predictor
        return self.predictors[video_id]

    def init_video(self, video_id: str, frame_dir: str):
        predictor = self._load_predictor(video_id)

        with torch.inference_mode():
            state = predictor.init_state(frame_dir)
            predictor.reset_state(state)

        self.states[video_id] = state

    def add_points(self, video_id: str, frame_idx: int, pos_points, neg_points):
        if video_id not in self.states:
            raise RuntimeError("Video not initialized. Call init_video first.")

        predictor = self._load_predictor(video_id)
        state = self.states[video_id]

        points = np.array(pos_points + neg_points, dtype=np.float32)
        labels = np.array([1] * len(pos_points) + [0] * len(neg_points), dtype=np.int32)

        with torch.inference_mode():
            _, out_obj_ids, out_mask_logits = predictor.add_new_points_or_box(
                inference_state=state,
                frame_idx=frame_idx,
                obj_id=1,
                points=points,
                labels=labels,
            )

        mask = (out_mask_logits[0] > 0).cpu().numpy().astype("uint8") * 255
        return np.squeeze(mask)

    def propagate_and_save(self, video_id: str, out_dir: str):
        if video_id not in self.states:
            raise RuntimeError("Video not initialized. Call init_video first.")

        predictor = self._load_predictor(video_id)
        state = self.states[video_id]

        os.makedirs(out_dir, exist_ok=True)

        saved = 0

        with torch.inference_mode():
            for out_frame_idx, out_obj_ids, out_mask_logits in predictor.propagate_in_video(state):
                for i, out_obj_id in enumerate(out_obj_ids):
                    mask = (out_mask_logits[i] > 0).cpu().numpy().astype("uint8") * 255
                    mask = np.squeeze(mask)

                    path = os.path.join(out_dir, f"{out_frame_idx:05d}.png")
                    Image.fromarray(mask).save(path)
                    saved += 1

        return saved