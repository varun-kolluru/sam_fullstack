import os
import torch
import numpy as np
from PIL import Image
from sam2.build_sam import build_sam2_video_predictor


def _sanitize_label(label: str) -> str:
    """Sanitize label for use in filename."""
    safe = "".join(c if c.isalnum() or c in ('-', '_') else '_' for c in label)
    return safe[:50] if safe else "object"


class SAM2Service:
    def __init__(
        self,
        cfg: str = "configs/sam2.1/sam2.1_hiera_t.yaml",
        ckpt: str = "checkpoints/sam2.1_hiera_tiny.pt",
    ):
        self.device = "cuda" if torch.cuda.is_available() else "mps"
        self.cfg = cfg
        self.ckpt = ckpt
        self._predictor = None
        self.states: dict[str, object] = {}

    def _get_predictor(self):
        """Lazily build and cache the SAM-2 predictor."""
        if self._predictor is None:
            self._predictor = build_sam2_video_predictor(
                config_file=self.cfg,
                ckpt_path=self.ckpt,
                device=self.device,
                vos_optimized=False,
            )
        return self._predictor

    @staticmethod
    def _logits_to_uint8(logit_tensor: torch.Tensor) -> np.ndarray:
        """Convert logit tensor to uint8 mask."""
        mask = (logit_tensor > 0).cpu().numpy().astype("uint8") * 255
        return np.squeeze(mask)

    def init_video(self, video_name: str, frame_dir: str) -> None:
        """Initialize inference state for video."""
        predictor = self._get_predictor()
        with torch.inference_mode():
            state = predictor.init_state(video_path=frame_dir)
            predictor.reset_state(state)
        self.states[video_name] = state

    def _require_state(self, video_name: str):
        if video_name not in self.states:
            raise RuntimeError(
                f"Video '{video_name}' is not initialised. Call init_video first."
            )
        return self.states[video_name]

    def add_prompts(
        self,
        video_name: str,
        frame_idx: int,
        obj_id: int,
        pos_points: list[list[int]] | None = None,
        neg_points: list[list[int]] | None = None,
        box: list[int] | None = None,
        binary_mask: np.ndarray | None = None,
    ) -> np.ndarray:
        """Add any combination of prompts: mask, points, and/or box for object."""
        state = self._require_state(video_name)
        predictor = self._get_predictor()

        with torch.inference_mode():
            predictor.remove_object(state,obj_id)
        
        # First, add mask if provided
        if binary_mask is not None:
            print("mask also present")
            with torch.inference_mode():
                _, out_obj_ids, out_mask_logits = predictor.add_new_mask(
                    inference_state=state,
                    frame_idx=frame_idx,
                    obj_id=obj_id,
                    mask=binary_mask.astype(bool),
                )
        
        # Then, add points/box if provided (to refine the mask)
        has_points = (pos_points and len(pos_points) > 0) or (neg_points and len(neg_points) > 0)
        has_box = box is not None
        
        if has_points or has_box:
            # Build points/labels arrays
            all_points, all_labels = [], []
            if pos_points:
                all_points.extend(pos_points)
                all_labels.extend([1] * len(pos_points))
            if neg_points:
                all_points.extend(neg_points)
                all_labels.extend([0] * len(neg_points))

            kwargs = dict(inference_state=state, frame_idx=frame_idx, obj_id=obj_id)
            if all_points:
                kwargs["points"] = np.array(all_points, dtype=np.float32)
                kwargs["labels"] = np.array(all_labels, dtype=np.int32)
            if box:
                kwargs["box"] = np.array(box, dtype=np.float32)

            with torch.inference_mode():
                _, out_obj_ids, out_mask_logits = predictor.add_new_points_or_box(**kwargs)
        
        # If only mask was provided, out_obj_ids and out_mask_logits are already set
        obj_index = out_obj_ids.index(obj_id) if obj_id in out_obj_ids else 0
        return self._logits_to_uint8(out_mask_logits[obj_index])

    def propagate_and_save(
        self,
        video_name: str,
        out_dir: str,
        start_frame_idx: int = 0,
        end_frame_idx: int | None = None,
        obj_labels: dict[str, str] | None = None,
    ) -> int:
        """Propagate prompts through video and save per-frame masks."""
        state = self._require_state(video_name)
        predictor = self._get_predictor()
        os.makedirs(out_dir, exist_ok=True)
        
        obj_labels = obj_labels or {}
        max_frame_num_to_track = None
        if end_frame_idx is not None:
            max_frame_num_to_track = end_frame_idx - start_frame_idx

        saved = 0
        with torch.inference_mode():
            for out_frame_idx, out_obj_ids, out_mask_logits in predictor.propagate_in_video(
                state,
                start_frame_idx=start_frame_idx,
                max_frame_num_to_track=max_frame_num_to_track
            ):
                for i, out_obj_id in enumerate(out_obj_ids):
                    mask = self._logits_to_uint8(out_mask_logits[i])
                    label = obj_labels.get(str(out_obj_id), f"Object_{out_obj_id}")
                    safe_label = _sanitize_label(label)
                    path = os.path.join(out_dir, f"{out_frame_idx:05d}_{out_obj_id}_{safe_label}.png")
                    Image.fromarray(mask).save(path)
                    saved += 1
        return saved

    def clear_video(self, video_name: str) -> None:
        """Remove inference state to free GPU memory."""
        self.states.pop(video_name, None)