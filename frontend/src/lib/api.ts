export const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:8000';

export interface ObjColorEntry { r: number; g: number; b: number; }

async function handleResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    let message = text;
    try { message = JSON.parse(text).detail ?? text; } catch { /* ignore */ }
    throw new Error(message);
  }
  return res.json();
}

// ── Video management ────────────────────────────────────────────────────────
export function getVideoStreamUrl(videoName: string): string {
  return `${API_BASE}/videos/${encodeURIComponent(videoName)}/stream`;
}

export async function listVideos(): Promise<{ videos: string[] }> {
  return handleResponse(await fetch(`${API_BASE}/videos`));
}

export async function selectVideo(videoName: string) {
  return handleResponse(await fetch(`${API_BASE}/select-video`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ video_name: videoName }),
  }));
}

export async function uploadVideo(
  file: File,
  name: string,
  onProgress?: (pct: number) => void,
) {
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    fd.append('video', file);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API_BASE}/upload-video?name=${encodeURIComponent(name)}`);
    
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

// ── Segmentation ────────────────────────────────────────────────────────────
export async function segmentFrame(body: {
  video_name: string;
  frame_idx: number;
  obj_id: number;
  obj_label: string;
  positive_points?: number[][];
  negative_points?: number[][];
  box?: number[] | null;
  mask_b64?: string;
}) {
  return handleResponse(await fetch(`${API_BASE}/segment-frame`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));
}
// ── Propagation ─────────────────────────────────────────────────────────────
export async function propagate(
  videoName: string,
  startFrameIdx: number,
  endFrameIdx?: number,
) {
  return handleResponse(await fetch(`${API_BASE}/propagate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      video_name: videoName,
      start_frame_idx: startFrameIdx,
      end_frame_idx: endFrameIdx ?? null,
    }),
  }));
}

// ── Polygon extraction ──────────────────────────────────────────────────────
export async function getMaskPolygons(
  videoName: string,
  frameIdx: number,
  objId: number,
): Promise<{ polygons: { x: number; y: number }[][] }> {
  const url = `${API_BASE}/videos/${encodeURIComponent(videoName)}/frames/${frameIdx}/polygons?obj_id=${objId}`;
  return handleResponse(await fetch(url));
}

// ── Object metadata ─────────────────────────────────────────────────────────
export async function getObjectLabels(videoName: string) {
  return handleResponse(await fetch(`${API_BASE}/videos/${encodeURIComponent(videoName)}/objects`));
}

// ── Masked video render ─────────────────────────────────────────────────────
export async function renderMaskedVideo(
  videoName: string,
  objColors: Record<string, ObjColorEntry> = {},
  alpha = 0.45,
) {
  return handleResponse(await fetch(`${API_BASE}/render-masked-video`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ video_name: videoName, alpha, obj_colors: objColors }),
  }));
}