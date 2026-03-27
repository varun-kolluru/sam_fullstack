export const API_BASE = 'http://localhost:8000';

export interface UploadResponse {
  video_name: string;
  fps: number;
  total_frames: number;
}

export interface VideoInfo {
  video_name: string;
  fps: number;
  total_frames: number;
}

export interface SegmentResponse {
  mask_path: string;
}

export interface PropagateResponse {
  masks_folder: string;
  total_masks_saved: number;
}

/** GET /videos → { videos: string[] } */
export async function listVideos(): Promise<string[]> {
  const res = await fetch(`${API_BASE}/videos`);
  if (!res.ok) throw new Error('Failed to list videos');
  const data = await res.json();
  return data.videos;
}

/** POST /select-video  { video_name } → VideoInfo + initialises SAM-2 */
export async function selectVideo(video_name: string): Promise<VideoInfo> {
  const res = await fetch(`${API_BASE}/select-video`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ video_name }),
  });
  if (!res.ok) throw new Error('Failed to select video');
  return res.json();
}

/** GET /videos/{video_name}/stream → video blob URL */
export function getVideoStreamUrl(video_name: string): string {
  return `${API_BASE}/videos/${video_name}/stream`;
}

/** POST /upload-video?name={name}  FormData(video) → UploadResponse */
export async function uploadVideo(
  file: File,
  name: string,
  onProgress: (percent: number) => void
): Promise<UploadResponse> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API_BASE}/upload-video?name=${encodeURIComponent(name)}`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress((e.loaded / e.total) * 100);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(JSON.parse(xhr.responseText));
      } else {
        let msg = `Upload failed (${xhr.status})`;
        try {
          const body = JSON.parse(xhr.responseText);
          if (body.detail) msg = body.detail;
        } catch { /* ignore */ }
        reject(new Error(msg));
      }
    };
    xhr.onerror = () => reject(new Error('Network error during upload'));
    const fd = new FormData();
    fd.append('video', file);
    xhr.send(fd);
  });
}

/** POST /segment-frame/points */
export async function segmentFramePoints(data: {
  video_name: string;
  frame_idx: number;
  obj_id: number;
  positive_points: number[][];
  negative_points: number[][];
  box: number[] | null;
}): Promise<SegmentResponse> {
  const res = await fetch(`${API_BASE}/segment-frame/points`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || 'Segmentation failed');
  }
  return res.json();
}

/** POST /segment-frame/mask */
export async function segmentFrameMask(data: {
  video_name: string;
  frame_idx: number;
  obj_id: number;
  mask_b64: string;
}): Promise<SegmentResponse> {
  const res = await fetch(`${API_BASE}/segment-frame/mask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || 'Mask segmentation failed');
  }
  return res.json();
}

/** POST /propagate  { video_name } */
export async function propagate(video_name: string, start_frame_idx: Number, end_frame_idx: Number): Promise<PropagateResponse> {
  const res = await fetch(`${API_BASE}/propagate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ video_name, start_frame_idx, end_frame_idx }),
  });
  if (!res.ok) throw new Error('Propagation failed');
  return res.json();
}


export interface RenderMaskedVideoResponse {
  masked_video_name: string;
  video_url: string;
}

/** POST /render-masked-video */
export async function renderMaskedVideo(
  video_name: string,
  alpha = 0.45
): Promise<RenderMaskedVideoResponse> {
  const res = await fetch(`${API_BASE}/render-masked-video`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ video_name, alpha }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || 'Render failed');
  }
  return res.json();
}
