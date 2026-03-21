# backend/sam2_service.py
import os
import torch
import numpy as np
from PIL import Image
from sam2.build_sam import build_sam2_video_predictor
from skimage.segmentation import slic
from skimage.util import img_as_float

class SAM2Service:
    def __init__(self, model_type="sam2"):
        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        self.model_type = model_type
        
        self.cfg = "configs/sam2.1/sam2.1_hiera_t.yaml"
        self.ckpt = "checkpoints/sam2.1_hiera_tiny.pt"

        self.predictors = {}
        self.states = {}
        self.mask_cache = {}   # video_id → {frame_idx → mask}

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

        # self.states[video_id] = state
        # bundle = self.states[video_id]
        # state = bundle["sam_state"]
        self.states[video_id] = {
            "sam_state": state,
            "frame_dir": frame_dir
        }

    def add_points(self, video_id: str, frame_idx: int, pos_points, neg_points):
        if video_id not in self.states:
            raise RuntimeError("Video not initialized. Call init_video first.")

        predictor = self._load_predictor(video_id)
        # state = self.states[video_id]
        bundle = self.states[video_id]
        state = bundle["sam_state"]

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
        # state = self.states[video_id]
        bundle = self.states[video_id]
        state = bundle["sam_state"]
        os.makedirs(out_dir, exist_ok=True)

        frame_count = 0

        with torch.inference_mode():
            for out_frame_idx, out_obj_ids, out_mask_logits in predictor.propagate_in_video(state):
                # Merge all object masks into one per frame (union)
                merged_mask = None
                for i in range(len(out_obj_ids)):
                    mask = (out_mask_logits[i] > 0).cpu().numpy().astype("uint8") * 255
                    mask = np.squeeze(mask)
                    if merged_mask is None:
                        merged_mask = mask
                    else:
                        merged_mask = np.maximum(merged_mask, mask)

                if merged_mask is not None:
                    path = os.path.join(out_dir, f"{out_frame_idx:05d}.png")
                    Image.fromarray(merged_mask).save(path)
                    frame_count += 1

        return frame_count
    
    def propagate_next_frame(self, video_id: str, current_frame_idx: int):
        if video_id not in self.states:
            raise RuntimeError("Video not initialized.")

        predictor = self.predictors[video_id]
        # state = self.states[video_id]
        bundle = self.states[video_id]
        state = bundle["sam_state"]

        next_frame_idx = current_frame_idx + 1

        with torch.inference_mode():
            for out_frame_idx, out_obj_ids, out_mask_logits in predictor.propagate_in_video(
                state,
                start_frame_idx=current_frame_idx,  # start from current
                max_frame_num_to_track=1             # only go 1 frame ahead
            ):
                if out_frame_idx == next_frame_idx:
                    merged_mask = None
                    for i in range(len(out_obj_ids)):
                        mask = (out_mask_logits[i] > 0).cpu().numpy().astype("uint8") * 255
                        mask = np.squeeze(mask)
                        merged_mask = mask if merged_mask is None else np.maximum(merged_mask, mask)
                    return next_frame_idx, merged_mask

        return None, None  # already at last frame
        
    # -------------------------------------------------------
    # SUPERPIXEL REFINEMENT
    # -------------------------------------------------------
    # def refine_mask_with_superpixels(self, frame, mask, box):

    #     h, w = mask.shape

    #     x1 = max(0, x1)
    #     y1 = max(0, y1)
    #     x2 = min(w, x2)
    #     y2 = min(h, y2)

    #     x1, y1, x2, y2 = box

    #     frame_crop = frame[y1:y2, x1:x2]
    #     mask_crop = mask[y1:y2, x1:x2]

    #     if frame_crop.size == 0:
    #         return mask

    #     image_float = img_as_float(frame_crop)

    #     segments = slic(
    #         image_float,
    #         n_segments=120,
    #         compactness=10,
    #         sigma=1,
    #         start_label=0,
    #     )

    #     refined = np.zeros_like(mask_crop)

    #     for seg_id in np.unique(segments):
    #         region = segments == seg_id
    #         coverage = mask_crop[region].mean() / 255.0

    #         if coverage >= 0.7:
    #             refined[region] = 255

    #     new_mask = mask.copy()
    #     new_mask[y1:y2, x1:x2] = refined

    #     return new_mask

    def refine_mask_with_superpixels(self, frame, mask, box):
        x1, y1, x2, y2 = box

        h, w = mask.shape

        # clamp to image boundary
        x1 = max(0, x1)
        y1 = max(0, y1)
        x2 = min(w, x2)
        y2 = min(h, y2)

        if x2 <= x1 or y2 <= y1:
            return mask

        frame_crop = frame[y1:y2, x1:x2]
        mask_crop = mask[y1:y2, x1:x2]

        if frame_crop.size == 0:
            return mask

        image_float = img_as_float(frame_crop)

        segments = slic(
            image_float,
            n_segments=120,
            compactness=10,
            sigma=1,
            start_label=0,
        )

        refined = np.zeros_like(mask_crop)

        for seg_id in np.unique(segments):
            region = segments == seg_id
            coverage = mask_crop[region].mean() / 255.0

            if coverage >= 0.7:
                refined[region] = 255

        new_mask = mask.copy()
        new_mask[y1:y2, x1:x2] = refined

        return new_mask

    def segment(self, video_id: str, frame_idx: int, positive_points=None, negative_points=None, boxes=None, polygon=None,):
        if video_id not in self.states:
            raise RuntimeError("Video not initialized. Call init_video first.")

        predictor = self._load_predictor(video_id)
        # state = self.states[video_id]
        bundle = self.states[video_id]
        state = bundle["sam_state"]

        pts = []
        lbls = []

        # ---------- positive ----------
        if positive_points:
            for p in positive_points:
                pts.append(p)
                lbls.append(1)

        # ---------- negative ----------
        if negative_points:
            for p in negative_points:
                pts.append(p)
                lbls.append(0)

        point_array = None
        label_array = None

        if len(pts) > 0:
            point_array = np.array(pts, dtype=np.float32)
            label_array = np.array(lbls, dtype=np.int32)

        # ---------- box ----------
        box_array = None
        if boxes and len(boxes) > 0:
            b = boxes[-1]     # take latest drawn box
            box_array = np.array(b, dtype=np.float32)

        # ---------- reject empty ----------
        if point_array is None and box_array is None:
            raise RuntimeError("No prompt provided")

        with torch.inference_mode():
            _, out_obj_ids, out_mask_logits = predictor.add_new_points_or_box(
                inference_state=state,
                frame_idx=frame_idx,
                obj_id=1,
                points=point_array,
                labels=label_array,
                box=box_array,
            )

        mask = (out_mask_logits[0] > 0).cpu().numpy().astype("uint8") * 255
        mask = np.squeeze(mask)

        if box_array is not None:
            # frame_path = state.frame_paths[frame_idx]
            # frame_path = state.frame_paths[frame_idx]
            frame_dir = bundle["frame_dir"]

            # frame_path = os.path.join(
            #     frame_dir,
            #     f"{frame_idx:05d}.jpg"
            # )
            frame_path = os.path.join(frame_dir, f"{frame_idx:05d}.jpg")

            if not os.path.exists(frame_path):
                frame_path = os.path.join(frame_dir, f"{frame_idx:05d}.png")

            if not os.path.exists(frame_path):
                raise RuntimeError(f"Frame not found for idx {frame_idx}")

            frame = np.array(Image.open(frame_path).convert("RGB"))

            mask = self.refine_mask_with_superpixels(
                frame,
                mask,
                box_array.astype(int),
            )

        if video_id not in self.mask_cache:
            self.mask_cache[video_id] = {}
        self.mask_cache[video_id][frame_idx] = mask

        return mask

    # def propagate(self, video_id):

    #     if video_id not in self.states:
    #         raise RuntimeError("Video not initialized. Call init_video first.")

    #     predictor = self.predictors[video_id]
    #     # inference_state = self.states[video_id]
    #     bundle = self.states[video_id]
    #     inference_state = bundle["sam_state"]

    #     # -------------------------
    #     # Print device info
    #     # -------------------------
    #     print("=================================")
    #     print(f"Propagation started for video: {video_id}")
    #     print(f"Running on device: {self.device}")

    #     if torch.cuda.is_available():
    #         print("CUDA DEVICE:", torch.cuda.get_device_name(0))
    #         print("GPU MEMORY ALLOCATED:",
    #             round(torch.cuda.memory_allocated(0)/1024**2, 2), "MB")
    #     else:
    #         print("CUDA not available — running on CPU")

    #     print("=================================")

    #     video_segments = {}

    #     with torch.inference_mode():
    #         for out_frame_idx, out_obj_ids, out_mask_logits in predictor.propagate_in_video(inference_state,start_frame_idx=0,max_frame_num_to_track=20):

    #             mask = (out_mask_logits[0] > 0).cpu().numpy().astype("uint8") * 255
    #             mask = np.squeeze(mask)
    #             video_segments[out_frame_idx] = mask
    #             if video_id not in self.mask_cache:
    #                 self.mask_cache[video_id] = {}
    #             self.mask_cache[video_id][out_frame_idx] = mask
            

    #     print("Propagation finished.")

    #     return video_segments

    def propagate(self, video_id):
        if video_id not in self.states:
            raise RuntimeError("Video not initialized. Call init_video first.")

        bundle = self.states[video_id]
        inference_state = bundle["sam_state"]
        predictor = self.predictors[video_id]

        print("========== TRACKING START ==========")

        video_segments = {}

        with torch.inference_mode():

            for out_frame_idx, out_obj_ids, out_mask_logits in predictor.propagate_in_video(
                inference_state
            ):

                print("tracking frame:", out_frame_idx)

                mask = (out_mask_logits[0] > 0).cpu().numpy().astype("uint8") * 255
                mask = np.squeeze(mask)

                video_segments[out_frame_idx] = mask

                if video_id not in self.mask_cache:
                    self.mask_cache[video_id] = {}

                self.mask_cache[video_id][out_frame_idx] = mask

        print("========== TRACKING END ==========")

        return video_segments