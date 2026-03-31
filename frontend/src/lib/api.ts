/**
 * api.ts  –  updated renderMaskedVideo to accept per-object RGB colours.
 *
 * Replace the existing renderMaskedVideo export in your api.ts with this version.
 * All other exports stay the same.
 */

export const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:8000';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ObjColorEntry { r: number; g: number; b: number; }

// ── Helpers ───────────────────────────────────────────────────────────────────

async function handleResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    let message = text;
    try { message = JSON.parse(text).detail ?? text; } catch { /* ignore */ }
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

// ── Video management ──────────────────────────────────────────────────────────

export function getVideoStreamUrl(videoName: string): string {
  return `${API_BASE}/videos/${encodeURIComponent(videoName)}/stream`;
}

export async function listVideos(): Promise<{ videos: string[] }> {
  const res = await fetch(`${API_BASE}/videos`);
  return handleResponse(res);
}

export async function selectVideo(
  videoName: string,
): Promise<{ video_name: string; fps: number; total_frames: number }> {
  const res = await fetch(`${API_BASE}/select-video`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ video_name: videoName }),
  });
  return handleResponse(res);
}

export async function uploadVideo(
  file: File,
  name: string,
  onProgress?: (pct: number) => void,
): Promise<{ video_name: string; fps: number; total_frames: number }> {
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    fd.append('video', file);
    const url = `${API_BASE}/upload-video?name=${encodeURIComponent(name)}`;
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    if (onProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
      };
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(JSON.parse(xhr.responseText));
      } else {
        let msg = xhr.statusText;
        try { msg = JSON.parse(xhr.responseText).detail ?? msg; } catch { /* ignore */ }
        reject(new Error(msg));
      }
    };
    xhr.onerror = () => reject(new Error('Network error during upload'));
    xhr.send(fd);
  });
}

// ── Segmentation ──────────────────────────────────────────────────────────────

export async function segmentFramePoints(body: {
  video_name: string;
  frame_idx: number;
  obj_id: number;
  positive_points: number[][];
  negative_points: number[][];
  box: number[] | null;
}): Promise<{ mask_path: string }> {
  const res = await fetch(`${API_BASE}/segment-frame/points`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return handleResponse(res);
}

export async function segmentFrameMask(body: {
  video_name: string;
  frame_idx: number;
  obj_id: number;
  mask_b64: string;
}): Promise<{ mask_path: string }> {
  const res = await fetch(`${API_BASE}/segment-frame/mask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return handleResponse(res);
}

// ── Propagation ───────────────────────────────────────────────────────────────

export async function propagate(
  videoName: string,
  startFrameIdx: number,
  endFrameIdx?: number,
): Promise<{ total_masks_saved: number; masks_folder: string }> {
  const res = await fetch(`${API_BASE}/propagate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      video_name: videoName,
      start_frame_idx: startFrameIdx,
      end_frame_idx: endFrameIdx ?? null,
    }),
  });
  return handleResponse(res);
}

// ── Masked video render ───────────────────────────────────────────────────────

/**
 * Render the masked video.
 *
 * @param videoName  - server-side video name
 * @param objColors  - map of obj_id (as string) → { r, g, b } (0-255 each)
 * @param alpha      - overlay opacity (default 0.45)
 */
export async function renderMaskedVideo(
  videoName: string,
  objColors: Record<string, ObjColorEntry> = {},
  alpha = 0.45,
): Promise<{ masked_video_name: string; video_url: string }> {
  const res = await fetch(`${API_BASE}/render-masked-video`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      video_name: videoName,
      alpha,
      obj_colors: objColors,
    }),
  });
  return handleResponse(res);
}