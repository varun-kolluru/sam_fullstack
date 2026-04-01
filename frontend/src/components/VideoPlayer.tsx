import { useRef, useState, useEffect, useCallback, MutableRefObject } from 'react';
import { Play, Pause } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';

export interface Point { x: number; y: number; }
export interface Box { x1: number; y1: number; x2: number; y2: number; }

export interface Annotations {
  positivePoints: Point[];
  negativePoints: Point[];
  boxes: Box[];
  polygons: Point[][];
}

type Tool = 'none' | 'positive' | 'negative' | 'box' | 'polygon';

interface VideoPlayerProps {
  videoUrl: string;
  activeTool: Tool;
  annotations: Annotations;
  onAnnotationsChange: (a: Annotations) => void;
  maskUrl: string | null;
  /** Hex colour for the mask overlay of the current object, e.g. '#1d9e75' */
  maskColor?: string;
  fps: number;
  onFrameIdxChange: (idx: number) => void;
  isPaused: boolean;
  onPausedChange: (paused: boolean) => void;
  clearSignal?: number;
  onVideoSizeChange?: (size: { w: number; h: number }) => void;
  onCurrentTimeChange?: (t: number) => void;
  seekToRef?: MutableRefObject<((seekFn: (t: number) => void) => void) | null>;
  hidePrompts?: boolean;
  /** Hex colour used for annotation overlays (points, boxes, polygons) */
  activeObjectColor?: string;
}

/** Parse a hex colour (#rrggbb) into an rgba() CSS string with given alpha. */
function hexToRgba(hex: string, alpha: number): string {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.substring(0, 2), 16);
  const g = parseInt(clean.substring(2, 4), 16);
  const b = parseInt(clean.substring(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

const DEFAULT_COLOR = '#1d9e75';

const VideoPlayer = ({
  videoUrl, activeTool, annotations, onAnnotationsChange,
  maskUrl, maskColor = DEFAULT_COLOR,
  fps, onFrameIdxChange, onCurrentTimeChange,
  isPaused, onPausedChange, clearSignal, onVideoSizeChange,
  seekToRef, hidePrompts = false,
  activeObjectColor = DEFAULT_COLOR,
}: VideoPlayerProps) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [videoSize, setVideoSize] = useState({ w: 0, h: 0 });
  const [drawingBox, setDrawingBox] = useState<{ start: Point; current: Point } | null>(null);
  const [currentPolygon, setCurrentPolygon] = useState<Point[]>([]);
  const [maskImage, setMaskImage] = useState<HTMLImageElement | null>(null);

  // Drag-to-edit polygon vertices
  const dragRef = useRef<{ polyIdx: number; ptIdx: number } | null>(null);
  const [isDraggingVertex, setIsDraggingVertex] = useState(false);
  // Hover state for cursor feedback
  const [hoveringVertex, setHoveringVertex] = useState(false);

  useEffect(() => {
    if (clearSignal) { setCurrentPolygon([]); setDrawingBox(null); }
  }, [clearSignal]);

  useEffect(() => {
    if ((annotations as any).__undoPolygonPoint) {
      setCurrentPolygon(prev => prev.length > 0 ? prev.slice(0, -1) : prev);
      const { __undoPolygonPoint, ...clean } = annotations as any;
      onAnnotationsChange(clean as Annotations);
    }
  }, [annotations, onAnnotationsChange]);

  useEffect(() => {
    if (!maskUrl) { setMaskImage(null); return; }
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = maskUrl;
    img.onload = () => setMaskImage(img);
  }, [maskUrl]);

  const getDisplayRect = useCallback(() => {
    const video = videoRef.current;
    const container = containerRef.current;
    if (!video || !container || !video.videoWidth) return null;
    const cw = container.clientWidth;
    const ch = container.clientHeight;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const scale = Math.min(cw / vw, ch / vh);
    const dw = vw * scale;
    const dh = vh * scale;
    return { offsetX: (cw - dw) / 2, offsetY: (ch - dh) / 2, dw, dh, scale };
  }, []);

  const canvasToVideo = useCallback((cx: number, cy: number): Point | null => {
    const rect = getDisplayRect();
    if (!rect) return null;
    return {
      x: Math.round((cx - rect.offsetX) / rect.scale),
      y: Math.round((cy - rect.offsetY) / rect.scale),
    };
  }, [getDisplayRect]);

  const videoToCanvas = useCallback((vx: number, vy: number): Point | null => {
    const rect = getDisplayRect();
    if (!rect) return null;
    return { x: vx * rect.scale + rect.offsetX, y: vy * rect.scale + rect.offsetY };
  }, [getDisplayRect]);

  /** Returns { polyIdx, ptIdx } of the nearest polygon vertex within `threshold` canvas px, or null. */
  const hitTestVertex = useCallback((cx: number, cy: number, threshold = 10): { polyIdx: number; ptIdx: number } | null => {
    let best: { polyIdx: number; ptIdx: number } | null = null;
    let bestDist = threshold;
    annotations.polygons.forEach((poly, polyIdx) => {
      poly.forEach((pt, ptIdx) => {
        const cp = videoToCanvas(pt.x, pt.y);
        if (!cp) return;
        const d = Math.hypot(cx - cp.x, cy - cp.y);
        if (d < bestDist) { bestDist = d; best = { polyIdx, ptIdx }; }
      });
    });
    return best;
  }, [annotations.polygons, videoToCanvas]);

  const drawCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    canvas.width = container.clientWidth;
    canvas.height = container.clientHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const rect = getDisplayRect();
    if (!rect) return;

    // Mask overlay (paused frame only)
    if (maskImage && isPaused) {
      ctx.globalAlpha = 0.35;
      ctx.drawImage(maskImage, rect.offsetX, rect.offsetY, rect.dw, rect.dh);
      ctx.globalAlpha = 1;
    }

    if (hidePrompts) return;

    const solidColor = activeObjectColor;
    const lightColor = hexToRgba(activeObjectColor, 0.25);

    // Positive points — object colour
    annotations.positivePoints.forEach(p => {
      const cp = videoToCanvas(p.x, p.y);
      if (!cp) return;
      ctx.beginPath();
      ctx.arc(cp.x, cp.y, 6, 0, Math.PI * 2);
      ctx.fillStyle = solidColor;
      ctx.fill();
      ctx.strokeStyle = hexToRgba(activeObjectColor, 0.7);
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cp.x - 3, cp.y); ctx.lineTo(cp.x + 3, cp.y);
      ctx.moveTo(cp.x, cp.y - 3); ctx.lineTo(cp.x, cp.y + 3);
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    });

    // Negative points — always red
    annotations.negativePoints.forEach(p => {
      const cp = videoToCanvas(p.x, p.y);
      if (!cp) return;
      ctx.beginPath();
      ctx.arc(cp.x, cp.y, 6, 0, Math.PI * 2);
      ctx.fillStyle = 'hsl(0 70% 50%)';
      ctx.fill();
      ctx.strokeStyle = 'hsl(0 70% 65%)';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cp.x - 3, cp.y); ctx.lineTo(cp.x + 3, cp.y);
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    });

    // Boxes
    annotations.boxes.forEach(box => {
      const tl = videoToCanvas(box.x1, box.y1);
      const br = videoToCanvas(box.x2, box.y2);
      if (!tl || !br) return;
      ctx.strokeStyle = solidColor;
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 3]);
      ctx.strokeRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
      ctx.setLineDash([]);
    });

    // Completed polygons
    annotations.polygons.forEach((poly, polyIdx) => {
      if (poly.length < 2) return;
      ctx.beginPath();
      const first = videoToCanvas(poly[0].x, poly[0].y);
      if (!first) return;
      ctx.moveTo(first.x, first.y);
      for (let i = 1; i < poly.length; i++) {
        const p = videoToCanvas(poly[i].x, poly[i].y);
        if (p) ctx.lineTo(p.x, p.y);
      }
      ctx.closePath();
      ctx.strokeStyle = solidColor;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = lightColor;
      ctx.fill();

      // Render draggable vertex handles when polygon tool is active
      if (activeTool === 'polygon') {
        poly.forEach((pt, ptIdx) => {
          const cp = videoToCanvas(pt.x, pt.y);
          if (!cp) return;
          const isDragging =
            dragRef.current?.polyIdx === polyIdx && dragRef.current?.ptIdx === ptIdx;
          // Outer ring
          ctx.beginPath();
          ctx.arc(cp.x, cp.y, isDragging ? 9 : 7, 0, Math.PI * 2);
          ctx.fillStyle = isDragging ? solidColor : hexToRgba(activeObjectColor, 0.85);
          ctx.fill();
          ctx.strokeStyle = '#fff';
          ctx.lineWidth = 2;
          ctx.stroke();
          // Inner dot
          ctx.beginPath();
          ctx.arc(cp.x, cp.y, 3, 0, Math.PI * 2);
          ctx.fillStyle = '#fff';
          ctx.fill();
        });
      }
    });

    // In-progress box
    if (drawingBox) {
      const s = videoToCanvas(drawingBox.start.x, drawingBox.start.y);
      const c = videoToCanvas(drawingBox.current.x, drawingBox.current.y);
      if (s && c) {
        ctx.strokeStyle = hexToRgba(activeObjectColor, 0.8);
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 4]);
        ctx.strokeRect(s.x, s.y, c.x - s.x, c.y - s.y);
        ctx.setLineDash([]);
      }
    }

    // In-progress polygon
    if (currentPolygon.length > 0) {
      ctx.beginPath();
      const first = videoToCanvas(currentPolygon[0].x, currentPolygon[0].y);
      if (first) {
        ctx.moveTo(first.x, first.y);
        for (let i = 1; i < currentPolygon.length; i++) {
          const p = videoToCanvas(currentPolygon[i].x, currentPolygon[i].y);
          if (p) ctx.lineTo(p.x, p.y);
        }
        ctx.strokeStyle = solidColor;
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 4]);
        ctx.stroke();
        ctx.setLineDash([]);
        currentPolygon.forEach(pt => {
          const p = videoToCanvas(pt.x, pt.y);
          if (!p) return;
          ctx.beginPath();
          ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
          ctx.fillStyle = solidColor;
          ctx.fill();
        });
      }
    }
  }, [annotations, drawingBox, currentPolygon, maskImage, isPaused, videoToCanvas, getDisplayRect, hidePrompts, activeObjectColor]);

  useEffect(() => { drawCanvas(); }, [drawCanvas]);

  useEffect(() => {
    if (isPaused) return;
    const video = videoRef.current;
    if (!video) return;
    const interval = setInterval(() => {
      onFrameIdxChange(Math.floor(video.currentTime * (fps || 30)));
    }, 100);
    return () => clearInterval(interval);
  }, [isPaused, fps, onFrameIdxChange]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const ro = new ResizeObserver(() => drawCanvas());
    ro.observe(container);
    return () => ro.disconnect();
  }, [drawCanvas]);

  const seekVideo = useCallback((time: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = time;
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onSeeked = () => {
      const t = video.currentTime;
      setCurrentTime(t);
      onCurrentTimeChange?.(t);
      onFrameIdxChange(Math.floor(t * (fps || 30)));
      drawCanvas();
    };
    video.addEventListener('seeked', onSeeked);
    return () => video.removeEventListener('seeked', onSeeked);
  }, [fps, onFrameIdxChange, drawCanvas]);

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) { video.play(); onPausedChange(false); }
    else { video.pause(); onPausedChange(true); }
  };

  const handleSeek = (value: number[]) => seekVideo(value[0]);

  const getCanvasCoords = (e: React.MouseEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return { cx: e.clientX - rect.left, cy: e.clientY - rect.top };
  };

  const handleCanvasClick = (e: React.MouseEvent) => {
    if (!isPaused || activeTool === 'none') return;
    // Ignore click if we just finished dragging a vertex
    if (dragRef.current !== null) return;
    const coords = getCanvasCoords(e);
    if (!coords) return;
    // In polygon mode, don't add a point if the click was on an existing vertex
    if (activeTool === 'polygon' && hitTestVertex(coords.cx, coords.cy)) return;
    const vp = canvasToVideo(coords.cx, coords.cy);
    if (!vp) return;
    if (activeTool === 'positive') {
      onAnnotationsChange({ ...annotations, positivePoints: [...annotations.positivePoints, vp] });
    } else if (activeTool === 'negative') {
      onAnnotationsChange({ ...annotations, negativePoints: [...annotations.negativePoints, vp] });
    } else if (activeTool === 'polygon') {
      setCurrentPolygon(prev => [...prev, vp]);
    }
  };

  const handleCanvasDoubleClick = () => {
    if (activeTool === 'polygon' && currentPolygon.length >= 3) {
      onAnnotationsChange({ ...annotations, polygons: [...annotations.polygons, currentPolygon] });
      setCurrentPolygon([]);
    }
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    if (!isPaused) return;
    const coords = getCanvasCoords(e);
    if (!coords) return;

    // Polygon tool: check if clicking near an existing vertex → drag it
    if (activeTool === 'polygon' && annotations.polygons.length > 0) {
      const hit = hitTestVertex(coords.cx, coords.cy);
      if (hit) {
        dragRef.current = hit;
        setIsDraggingVertex(true);
        return; // Don't fall through to box logic
      }
    }

    if (activeTool !== 'box') return;
    const vp = canvasToVideo(coords.cx, coords.cy);
    if (!vp) return;
    setDrawingBox({ start: vp, current: vp });
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    const coords = getCanvasCoords(e);
    if (!coords) return;

    // Dragging a polygon vertex
    if (isDraggingVertex && dragRef.current) {
      const vp = canvasToVideo(coords.cx, coords.cy);
      if (!vp) return;
      const { polyIdx, ptIdx } = dragRef.current;
      const updatedPolygons = annotations.polygons.map((poly, pi) =>
        pi === polyIdx
          ? poly.map((pt, ti) => (ti === ptIdx ? vp : pt))
          : poly,
      );
      onAnnotationsChange({ ...annotations, polygons: updatedPolygons });
      return;
    }

    // Hover detection for cursor feedback (polygon tool only)
    if (activeTool === 'polygon' && isPaused) {
      const hit = hitTestVertex(coords.cx, coords.cy);
      setHoveringVertex(hit !== null);
    } else {
      setHoveringVertex(false);
    }

    // Box drawing
    if (!drawingBox) return;
    const vp = canvasToVideo(coords.cx, coords.cy);
    if (!vp) return;
    setDrawingBox(prev => prev ? { ...prev, current: vp } : null);
  };

  const handleMouseUp = () => {
    // End vertex drag
    if (isDraggingVertex) {
      dragRef.current = null;
      setIsDraggingVertex(false);
      return;
    }

    if (!drawingBox) return;
    const { start, current } = drawingBox;
    const x1 = Math.min(start.x, current.x);
    const y1 = Math.min(start.y, current.y);
    const x2 = Math.max(start.x, current.x);
    const y2 = Math.max(start.y, current.y);
    if (Math.abs(x2 - x1) > 5 && Math.abs(y2 - y1) > 5) {
      onAnnotationsChange({ ...annotations, boxes: [...annotations.boxes, { x1, y1, x2, y2 }] });
    }
    setDrawingBox(null);
  };

  const formatTime = (t: number) => {
    const mins = Math.floor(t / 60);
    const secs = Math.floor(t % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const cursorClass = (() => {
    if (!isPaused || activeTool === 'none') return 'cursor-default';
    if (isDraggingVertex) return 'cursor-grabbing';
    if (activeTool === 'polygon' && hoveringVertex) return 'cursor-grab';
    return 'cursor-crosshair';
  })();

  return (
    <div className="flex flex-col gap-3">
      <div
        ref={containerRef}
        className="relative w-full aspect-video bg-card rounded-lg overflow-hidden border border-border"
      >
        <video
          ref={videoRef}
          src={videoUrl}
          className="w-full h-full object-contain"
          onLoadedMetadata={(e) => {
            const v = e.currentTarget;
            setDuration(v.duration);
            const size = { w: v.videoWidth, h: v.videoHeight };
            setVideoSize(size);
            onVideoSizeChange?.(size);
            v.pause();
            onPausedChange(true);
            if (seekToRef?.current) {
              const cb = seekToRef.current;
              seekToRef.current = null;
              cb(seekVideo);
            }
          }}
          onTimeUpdate={(e) => {
            const t = e.currentTarget.currentTime;
            setCurrentTime(t);
            onCurrentTimeChange?.(t);
            onFrameIdxChange(Math.floor(t * (fps || 30)));
          }}
          onPause={() => onPausedChange(true)}
          onPlay={() => onPausedChange(false)}
          onEnded={() => onPausedChange(true)}
        />
        <canvas
          ref={canvasRef}
          className={`absolute inset-0 w-full h-full ${cursorClass}`}
          onClick={handleCanvasClick}
          onDoubleClick={handleCanvasDoubleClick}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={() => {
            setHoveringVertex(false);
            if (isDraggingVertex) {
              dragRef.current = null;
              setIsDraggingVertex(false);
            }
          }}
        />
      </div>

      <div className="flex items-center gap-3 px-2">
        <Button variant="tool" size="icon" onClick={togglePlay} className="shrink-0">
          {isPaused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
        </Button>
        <Slider
          value={[currentTime]}
          max={duration || 1}
          step={0.01}
          onValueChange={handleSeek}
          className="flex-1"
        />
        <span className="text-xs text-muted-foreground font-mono min-w-[80px] text-right">
          {formatTime(currentTime)} / {formatTime(duration)}
        </span>
      </div>

      {videoSize.w > 0 && (
        <div className="flex items-center gap-4 px-2 text-xs text-muted-foreground">
          <span>Frame: <span className="text-primary font-mono">{Math.floor(currentTime * (fps || 30))}</span></span>
          <span>Resolution: <span className="font-mono">{videoSize.w}×{videoSize.h}</span></span>
        </div>
      )}
    </div>
  );
};

export default VideoPlayer;