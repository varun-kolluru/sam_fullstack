import os
import torch
import numpy as np
from PIL import Image
from sam2.build_sam import build_sam2_video_predictor


class SAM2Service:
    def __init__(
        self,
        cfg: str = "configs/sam2.1/sam2.1_hiera_t.yaml",
        ckpt: str = "checkpoints/sam2.1_hiera_tiny.pt",
    ):
        self.device = "cuda" if torch.cuda.is_available() else "mps"
        self.cfg = cfg
        self.ckpt = ckpt

        # One predictor is shared across all videos (stateless model weights).
        # Inference state is per-video and held in self.states.
        self._predictor = None
        self.states: dict[str, object] = {}

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _get_predictor(self):
        """Lazily build and cache the SAM-2 predictor (model weights only)."""
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
        """Convert a raw logit tensor (C, H, W) or (H, W) to a uint8 mask."""
        mask = (logit_tensor > 0).cpu().numpy().astype("uint8") * 255
        return np.squeeze(mask)

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def init_video(self, video_name: str, frame_dir: str) -> None:
        """
        Initialise (or re-initialise) the inference state for *video_name*.

        Parameters
        ----------
        video_name : unique identifier / folder name for the video
        frame_dir  : directory that contains JPEG frames (00000.jpg, …)
        """
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

    # ---- point / box prompt ----------------------------------------

    def add_points_or_box(
        self,
        video_name: str,
        frame_idx: int,
        obj_id: int,
        pos_points: list[list[int]] | None = None,
        neg_points: list[list[int]] | None = None,
        box: list[int] | None = None,
    ) -> np.ndarray:
        """
        Add point clicks and / or a bounding box for *obj_id* on *frame_idx*.

        Parameters
        ----------
        pos_points : [[x, y], …]  positive clicks
        neg_points : [[x, y], …]  negative clicks
        box        : [x_min, y_min, x_max, y_max]

        Returns
        -------
        uint8 mask array (H, W), values 0 or 255
        """
        state = self._require_state(video_name)
        predictor = self._get_predictor()

        with torch.inference_mode():
            predictor.reset_state(state)

        # --- build points / labels arrays ---
        all_points = []
        all_labels = []

        if pos_points:
            all_points.extend(pos_points)
            all_labels.extend([1] * len(pos_points))

        if neg_points:
            all_points.extend(neg_points)
            all_labels.extend([0] * len(neg_points))

        np_points = np.array(all_points, dtype=np.float32) if all_points else None
        np_labels = np.array(all_labels, dtype=np.int32) if all_labels else None

        # --- build box array ---
        np_box = np.array(box, dtype=np.float32) if box else None

        kwargs: dict = dict(
            inference_state=state,
            frame_idx=frame_idx,
            obj_id=obj_id,
        )
        if np_points is not None:
            kwargs["points"] = np_points
            kwargs["labels"] = np_labels
        if np_box is not None:
            kwargs["box"] = np_box

        with torch.inference_mode():
            _, out_obj_ids, out_mask_logits = predictor.add_new_points_or_box(**kwargs)

        # Return the mask for the first (and usually only) returned object
        obj_index = out_obj_ids.index(obj_id) if obj_id in out_obj_ids else 0
        return self._logits_to_uint8(out_mask_logits[obj_index])

    # ---- binary mask prompt ----------------------------------------

    def add_mask(
        self,
        video_name: str,
        frame_idx: int,
        obj_id: int,
        binary_mask: np.ndarray,
    ) -> np.ndarray:
        """
        Add a binary mask prompt for *obj_id* on *frame_idx*.

        Parameters
        ----------
        binary_mask : bool / uint8 array of shape (H, W)

        Returns
        -------
        uint8 mask array (H, W), values 0 or 255
        """
        state = self._require_state(video_name)
        predictor = self._get_predictor()

        with torch.inference_mode():
            predictor.reset_state(state)

        # SAM-2 expects a boolean mask
        bool_mask = binary_mask.astype(bool)

        with torch.inference_mode():
            _, out_obj_ids, out_mask_logits = predictor.add_new_mask(
                inference_state=state,
                frame_idx=frame_idx,
                obj_id=obj_id,
                mask=bool_mask,
            )

        obj_index = out_obj_ids.index(obj_id) if obj_id in out_obj_ids else 0
        return self._logits_to_uint8(out_mask_logits[obj_index])

    # ---- propagation -----------------------------------------------

    def propagate_and_save(
        self,
        video_name: str,
        out_dir: str,
        start_frame_idx: int = 0,
        end_frame_idx: int | None = None
    ) -> int:
        """
        Propagate the current prompts through the video and save per-frame masks.

        Parameters
        ----------
        start_frame_idx : frame to begin propagation from (default 0)
        end_frame_idx   : last frame to include, inclusive (default = all frames)
        reverse         : propagate backwards if True

        Returns
        -------
        Number of mask frames saved.
        """
        state = self._require_state(video_name)
        predictor = self._get_predictor()

        os.makedirs(out_dir, exist_ok=True)
        saved = 0

        # Calculate max_frame_num_to_track from the range
        max_frame_num_to_track = None
        if end_frame_idx is not None:
            max_frame_num_to_track = end_frame_idx - start_frame_idx

        with torch.inference_mode():
            for out_frame_idx, out_obj_ids, out_mask_logits in predictor.propagate_in_video(
                state,
                start_frame_idx=start_frame_idx,
                max_frame_num_to_track=max_frame_num_to_track
            ):
                for i, out_obj_id in enumerate(out_obj_ids):
                    mask = self._logits_to_uint8(out_mask_logits[i])
                    path = os.path.join(out_dir, f"{out_frame_idx:05d}_{out_obj_id}.png")
                    Image.fromarray(mask).save(path)
                    saved += 1

        return saved

    def clear_video(self, video_name: str) -> None:
        """Remove the inference state for *video_name* to free GPU memory."""
        self.states.pop(video_name, None)
