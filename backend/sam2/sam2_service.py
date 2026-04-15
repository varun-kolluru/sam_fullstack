import os
import torch
import numpy as np
from PIL import Image
from sam2.build_sam import build_sam2_video_predictor
import shutil
from typing import Optional, Dict, List, Tuple


def _sanitize_label(label: str) -> str:
    """Sanitize label for use in filename."""
    safe = "".join(c if c.isalnum() or c in ('-', '_') else '_' for c in label)
    return safe[:50] if safe else "object"


class SAM2Service:
    def __init__(
        self,
        cfg: str = "configs/sam2.1/sam2.1_hiera_t.yaml",
        ckpt: str = "checkpoints/sam2.1_hiera_tiny.pt",
        batch_size: int = 10
    ):
        """
        Initialize SAM2 Service for long video processing.
        
        Args:
            cfg: Path to SAM2 config file
            ckpt: Path to SAM2 checkpoint
            batch_size: Number of frames to process per batch
            overlap_frames: Number of frames to use for continuity between batches
        """
        self.device = "cuda" if torch.cuda.is_available() else "mps"
        self.cfg = cfg
        self.ckpt = ckpt
        self.batch_size = batch_size
        self._predictor = None
        
        # Store video metadata
        self.video_metadata: Dict[str, Dict] = {}
        # Current loaded batch info
        self.current_batch_info: Dict[str, Dict] = {}
        # Store prompt information to replay across batches
        self.prompt_info: Dict[str, Dict] = {}

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
    
    @staticmethod
    def _logits_to_bool(logit_tensor: torch.Tensor) -> np.ndarray:
        """Convert logit tensor to boolean mask."""
        mask = (logit_tensor > 0).cpu().numpy().astype(bool)
        return np.squeeze(mask)

    def _get_batch_number(self, frame_idx: int) -> int:
        """Calculate which batch a frame belongs to."""
        return frame_idx // self.batch_size

    def _get_batch_frame_range(self, batch_num: int, total_frames: int) -> Tuple[int, int]:
        """Get the start and end frame indices for a batch."""
        start_frame = batch_num * self.batch_size
        end_frame = min(start_frame + self.batch_size, total_frames)
        return start_frame, end_frame

    def _get_frame_files(self, frame_dir: str) -> List[str]:
        """Get sorted list of frame files."""
        frame_files = sorted([
            f for f in os.listdir(frame_dir) 
            if f.lower().endswith(('.jpg', '.jpeg', '.png'))
        ])
        return frame_files

    def _count_frames(self, frame_dir: str) -> int:
        """Count total number of frames in directory."""
        return len(self._get_frame_files(frame_dir))

    def _create_batch_folder(
        self, 
        video_name: str, 
        source_dir: str, 
        batch_num: int,
        total_frames: int
    ) -> str:
        """Create temporary directory with symlinks for batch frames."""
        batch_dir = f"storage/tmp_batches/{video_name}/batch_{batch_num}"
        
        # Remove existing directory if it exists
        if os.path.exists(batch_dir):
            shutil.rmtree(batch_dir)
        os.makedirs(batch_dir, exist_ok=True)
        
        start_frame, end_frame = self._get_batch_frame_range(batch_num, total_frames)
        
        # Get all frame files
        all_frames = self._get_frame_files(source_dir)
        
        # Create symlinks for batch frames (renumbered from 0)
        for i, frame_idx in enumerate(range(start_frame, end_frame)):
            if frame_idx < len(all_frames):
                src = os.path.join(source_dir, all_frames[frame_idx])
                
                # Get the original file extension
                _, ext = os.path.splitext(all_frames[frame_idx])
                
                # Use 5-digit numbering starting from 0 with original extension
                dst = os.path.join(batch_dir, f"{i:05d}{ext}")
                
                if os.path.exists(src):
                    shutil.copy(src, dst)
                else:
                    print(f"Warning: Source file does not exist: {src}")
        
        return batch_dir

    def init_video(self, video_name: str, frame_dir: str) -> Dict:
        """Initialize video metadata (doesn't load frames yet)."""
        if not os.path.exists(frame_dir):
            raise RuntimeError(f"Frame directory does not exist: {frame_dir}")
        
        total_frames = self._count_frames(frame_dir)
        if total_frames == 0:
            raise RuntimeError(f"No frames found in directory: {frame_dir}")
        
        total_batches = (total_frames + self.batch_size - 1) // self.batch_size
        
        self.video_metadata[video_name] = {
            "frame_dir": frame_dir,
            "total_frames": total_frames,
            "total_batches": total_batches,
        }
        
        self.current_batch_info[video_name] = {
            "batch_num": None,
            "state": None,
            "batch_dir": None,
        }
        
        # Initialize empty prompt storage for each object
        self.prompt_info[video_name] = {}
        
        return {
            "total_frames": total_frames,
            "total_batches": total_batches,
            "batch_size": self.batch_size,
        }

    def _load_batch(self, video_name: str, batch_num: int) -> object:
        """Load a specific batch into memory with fresh state."""
        if video_name not in self.video_metadata:
            raise RuntimeError(f"Video '{video_name}' not initialized")
        
        metadata = self.video_metadata[video_name]
        predictor = self._get_predictor()
        
        # Create batch directory with frames
        batch_dir = self._create_batch_folder(
            video_name,
            metadata["frame_dir"],
            batch_num,
            metadata["total_frames"]
        )
        
        # Verify batch directory has frames
        batch_frames = self._get_frame_files(batch_dir)
        if len(batch_frames) == 0:
            raise RuntimeError(f"No frames created in batch directory: {batch_dir}")
        
        print(f"Loading batch {batch_num} with {len(batch_frames)} frames from {batch_dir}")
        
        # Initialize fresh state for this batch
        with torch.inference_mode():
            state = predictor.init_state(video_path=batch_dir)
            # Reset state to clear any previous memory
            predictor.reset_state(state)
        
        # Store current batch info
        self.current_batch_info[video_name] = {
            "batch_num": batch_num,
            "state": state,
            "batch_dir": batch_dir,
        }
        
        return state

    def _batch_relative_frame_idx(self, video_name: str, frame_idx: int) -> Tuple[object, int]:
        """Ensure the correct batch is loaded and return batch-relative frame index."""
        batch_num = self._get_batch_number(frame_idx)
        current_info = self.current_batch_info.get(video_name, {})
        
        # Check if we need to load a different batch
        if current_info.get("batch_num") != batch_num or current_info.get("state") is None:
            # Load new batch with fresh state
            state = self._load_batch(video_name, batch_num)
        else:
            state = current_info["state"]
        
        # Calculate batch-relative frame index
        start_frame, _ = self._get_batch_frame_range(batch_num, self.video_metadata[video_name]["total_frames"])
        batch_frame_idx = frame_idx - start_frame
        
        return state, batch_frame_idx

    def add_prompts(
        self,
        video_name: str,
        frame_idx: int,
        obj_id: int,
        pos_points: Optional[List[List[int]]] = None,
        neg_points: Optional[List[List[int]]] = None,
        box: Optional[List[int]] = None,
        binary_mask: Optional[np.ndarray] = None,
    ):
        """
        Add prompts (points, box, or mask) to a specific frame and object.
        This is the primary way to initialize object tracking.
        """
        if video_name not in self.video_metadata:
            raise RuntimeError(f"Video '{video_name}' not initialized")
        
        # Ensure correct batch is loaded
        state, batch_frame_idx = self._batch_relative_frame_idx(video_name, frame_idx)
        predictor = self._get_predictor()
        
        # Store prompt info for replay across batches
        if obj_id not in self.prompt_info[video_name]:
            self.prompt_info[video_name][obj_id] = {}
        
        self.prompt_info[video_name][obj_id] = {
            "frame_idx": frame_idx,
            "pos_points": pos_points,
            "neg_points": neg_points,
            "box": box,
            "binary_mask": binary_mask.copy() if binary_mask is not None else None,
        }
        
        has_points = (pos_points and len(pos_points) > 0) or (neg_points and len(neg_points) > 0)
        has_box = box is not None
        has_mask = binary_mask is not None
        
        with torch.inference_mode():
            # First, add mask if provided (masks take priority in SAM2)
            if has_mask:
                _, out_obj_ids, out_mask_logits = predictor.add_new_mask(
                    inference_state=state,
                    frame_idx=batch_frame_idx,
                    obj_id=obj_id,
                    mask=binary_mask.astype(bool),
                )
            
            # Then add points/box if provided (they refine the mask)
            if has_points or has_box:
                all_points, all_labels = [], []
                if pos_points:
                    all_points.extend(pos_points)
                    all_labels.extend([1] * len(pos_points))
                if neg_points:
                    all_points.extend(neg_points)
                    all_labels.extend([0] * len(neg_points))

                kwargs = dict(
                    inference_state=state, 
                    frame_idx=batch_frame_idx, 
                    obj_id=obj_id,
                    clear_old_points=False,  # Don't clear if we added a mask first
                )
                if all_points:
                    kwargs["points"] = np.array(all_points, dtype=np.float32)
                    kwargs["labels"] = np.array(all_labels, dtype=np.int32)
                if box:
                    kwargs["box"] = np.array(box, dtype=np.float32)

                _, out_obj_ids, out_mask_logits = predictor.add_new_points_or_box(**kwargs)
            
            # If neither mask nor points/box provided, raise error
            if not has_mask and not has_points and not has_box:
                raise ValueError("Must provide at least one of: mask, points, or box")
        
        print(f"Added prompts for object {obj_id} at global frame {frame_idx} (batch frame {batch_frame_idx})")
        
        # Extract the mask for the requested object
        obj_index = out_obj_ids.index(obj_id) if obj_id in out_obj_ids else 0
        return self._logits_to_uint8(out_mask_logits[obj_index])

    def _apply_prompts_to_state(
        self, 
        state: object, 
        batch_frame_idx: int, 
        obj_id: int,
        pos_points: Optional[List[List[int]]] = None,
        neg_points: Optional[List[List[int]]] = None,
        box: Optional[List[int]] = None,
        binary_mask: Optional[np.ndarray] = None,
    ):
        """
        Apply prompts to a state (helper for batch transitions).
        This is used internally to reinitialize objects in new batches.
        """
        predictor = self._get_predictor()
        
        has_points = (pos_points and len(pos_points) > 0) or (neg_points and len(neg_points) > 0)
        has_box = box is not None
        has_mask = binary_mask is not None
        
        with torch.inference_mode():
            # Add mask if provided
            if has_mask:
                predictor.add_new_mask(
                    inference_state=state,
                    frame_idx=batch_frame_idx,
                    obj_id=obj_id,
                    mask=binary_mask.astype(bool),
                )
            
            # Add points/box if provided
            if has_points or has_box:
                all_points, all_labels = [], []
                if pos_points:
                    all_points.extend(pos_points)
                    all_labels.extend([1] * len(pos_points))
                if neg_points:
                    all_points.extend(neg_points)
                    all_labels.extend([0] * len(neg_points))

                kwargs = dict(
                    inference_state=state, 
                    frame_idx=batch_frame_idx, 
                    obj_id=obj_id,
                    clear_old_points=False,
                )
                if all_points:
                    kwargs["points"] = np.array(all_points, dtype=np.float32)
                    kwargs["labels"] = np.array(all_labels, dtype=np.int32)
                if box:
                    kwargs["box"] = np.array(box, dtype=np.float32)

                predictor.add_new_points_or_box(**kwargs)

    def propagate_and_save(
        self,
        video_name: str,
        out_dir: str,
        start_frame_idx: int = 0,
        end_frame_idx: Optional[int] = None,
        obj_labels: Optional[Dict[str, str]] = None,
    ) -> int:
        """
        Propagate all tracked objects through the entire video using batch processing.
        
        Key insight: SAM2's memory mechanism works by:
        1. Initial conditioning frames (where prompts are added) 
        2. Propagation uses memory from previous frames
        3. Between batches, we use the last frame's mask as initialization
        
        Args:
            video_name: Name of the video to process
            out_dir: Output directory for masks
            start_frame_idx: Starting frame (global index)
            end_frame_idx: Ending frame (global index), None means till end
            obj_labels: Optional labels for objects {obj_id: label_name}
        
        Returns:
            Number of masks saved
        """
        end_frame_idx = start_frame_idx + self.batch_size*5

        if video_name not in self.video_metadata:
            raise RuntimeError(f"Video '{video_name}' not initialized")
        
        if not self.prompt_info.get(video_name):
            raise RuntimeError("No prompts added yet. Add prompts before propagation.")
        
        metadata = self.video_metadata[video_name]
        predictor = self._get_predictor()
        os.makedirs(out_dir, exist_ok=True)
        obj_labels = obj_labels or {}
        
        total_frames = metadata["total_frames"]
        total_batches = metadata["total_batches"]
        end_frame_idx = end_frame_idx or total_frames
        
        # Determine which batches we need to process
        start_batch = self._get_batch_number(start_frame_idx)
        end_batch = self._get_batch_number(min(end_frame_idx - 1, total_frames - 1))
        
        saved = 0
        
        # Storage for masks from last frames of each batch (for continuity)
        # Format: {obj_id: numpy_bool_mask}
        last_batch_masks: Dict[int, np.ndarray] = {}
        
        # Process all required batches
        for batch_num in range(start_batch, end_batch + 1):
            print(f"\nProcessing batch {batch_num + 1}/{total_batches}")
            
            batch_start, batch_end = self._get_batch_frame_range(batch_num, total_frames)
            print(f"  Batch frames: {batch_start} to {batch_end - 1} (global indices)")
            
            # Load fresh state for this batch
            state = self._load_batch(video_name, batch_num)
            
            # For each tracked object, add prompts to initialize in this batch
            for obj_id, prompt_data in self.prompt_info[video_name].items():
                original_prompt_frame = prompt_data["frame_idx"]
                prompt_batch_num = self._get_batch_number(original_prompt_frame)
                
                if batch_num == prompt_batch_num:
                    # First batch where this object appears: use original prompts
                    batch_prompt_frame = original_prompt_frame - batch_start
                    print(f"  Object {obj_id}: Using original prompts at frame {batch_prompt_frame}")
                    
                    self._apply_prompts_to_state(
                        state,
                        batch_prompt_frame,
                        obj_id,
                        prompt_data["pos_points"],
                        prompt_data["neg_points"],
                        prompt_data["box"],
                        prompt_data["binary_mask"],
                    )
                    
                elif batch_num > prompt_batch_num:
                    # Subsequent batches: use mask from last frame of previous batch
                    if obj_id in last_batch_masks:
                        print(f"  Object {obj_id}: Using mask from previous batch at frame 0")
                        
                        # Apply the mask from previous batch's last frame to first frame of this batch
                        self._apply_prompts_to_state(
                            state,
                            batch_frame_idx=0,  # First frame of this batch
                            obj_id=obj_id,
                            binary_mask=last_batch_masks[obj_id],
                        )
                    else:
                        print(f"  Warning: Object {obj_id} has no mask from previous batch, skipping")
                        continue
                else:
                    # This batch is before the object's prompt frame, skip this object
                    continue
            
            # Propagate through this batch
            print(f"  Starting propagation...")
            with torch.inference_mode():
                for out_frame_idx, out_obj_ids, out_mask_logits in predictor.propagate_in_video(
                    state,
                    start_frame_idx=batch_prompt_frame if batch_num==start_batch else 0,  # for 1st batch start with that perticular frame and next from 0
                ):
                    # Calculate global frame index
                    global_frame_idx = batch_start + out_frame_idx
                    
                    # Skip frames outside requested range
                    if global_frame_idx < start_frame_idx or global_frame_idx >= end_frame_idx:
                        continue
                    
                    # Process each object in this frame
                    for i, out_obj_id in enumerate(out_obj_ids):
                        # Convert to uint8 for saving
                        mask_uint8 = self._logits_to_uint8(out_mask_logits[i])
                        
                        # Save mask
                        label = obj_labels.get(str(out_obj_id), f"Object_{out_obj_id}")
                        safe_label = _sanitize_label(label)
                        path = os.path.join(
                            out_dir, 
                            f"{global_frame_idx:05d}_{out_obj_id}_{safe_label}.png"
                        )
                        Image.fromarray(mask_uint8).save(path)
                        saved += 1
                        
                        # Store mask from last frame for continuity with next batch
                        # We need boolean masks for reapplication
                        if out_frame_idx == (batch_end - batch_start - 1):  # Last frame of batch
                            last_batch_masks[out_obj_id] = self._logits_to_bool(out_mask_logits[i])
                            print(f"  Stored mask for object {out_obj_id} from last frame")
            
            print(f"  Saved {saved} masks so far")
            
            # Clean up and prepare for next batch
            if batch_num < end_batch:
                torch.cuda.empty_cache()
        
        print(f"\nPropagation complete! Saved {saved} masks total.")
        return saved

    def clear_video(self, video_name: str) -> None:
        """Remove inference state and metadata to free memory."""
        # Clear current batch
        if video_name in self.current_batch_info:
            current_info = self.current_batch_info[video_name]
            if current_info.get("batch_dir"):
                try:
                    shutil.rmtree(current_info["batch_dir"])
                except Exception as e:
                    print(f"Warning: Could not remove batch directory: {e}")
            self.current_batch_info.pop(video_name, None)
        
        # Clear metadata and prompts
        self.video_metadata.pop(video_name, None)
        self.prompt_info.pop(video_name, None)
        
        # Clear GPU cache
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
        
        print(f"Cleared video '{video_name}' from memory")