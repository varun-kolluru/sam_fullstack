export const API_BASE = 'http://localhost:8000';

export interface UploadResponse {
  video_id: string;
  fps: number;
  total_frames: number;
}

export interface SegmentResponse {
  mask_path: string;
}

export interface PropagateResponse {
  masks_folder: string;
  total_frames: number;
}

export async function uploadVideo(
  file: File,
  onUploadProgress: (percent: number) => void
): Promise<UploadResponse> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API_BASE}/upload-video`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onUploadProgress((e.loaded / e.total) * 100);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(JSON.parse(xhr.responseText));
      } else {
        reject(new Error(`Upload failed with status ${xhr.status}`));
      }
    };
    xhr.onerror = () => reject(new Error('Network error during upload'));
    const fd = new FormData();
    fd.append('video', file);
    xhr.send(fd);
  });
}

export async function segmentFrame(data: {
  video_id: string;
  frame_idx: number;
  positive_points: number[][];
  negative_points: number[][];
  boxes: number[][];
  polygon: number[][];
}): Promise<SegmentResponse> {
  const res = await fetch(`${API_BASE}/segment-frame`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error('Segmentation failed');
  return res.json();
}

export async function propagateVideoMask(
  video_id: string
): Promise<PropagateResponse> {
  const res = await fetch(`${API_BASE}/propagate-video-mask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ video_id }),
  });
  if (!res.ok) throw new Error('Propagation failed');
  return res.json();
}
