import { useRef, useState, useEffect, useCallback } from 'react';
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
  fps: number;
  onFrameIdxChange: (idx: number) => void;
  isPaused: boolean;
  onPausedChange: (paused: boolean) => void;
  clearSignal?: number;
  onVideoSizeChange?: (size: { w: number; h: number }) => void;
}

const VideoPlayer = ({
  videoUrl, activeTool, annotations, onAnnotationsChange,
  maskUrl, fps, onFrameIdxChange,
  isPaused, onPausedChange, clearSignal, onVideoSizeChange,
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

  // Clear in-progress polygon when clearSignal changes
  useEffect(() => {
    if (clearSignal) {
      setCurrentPolygon([]);
      setDrawingBox(null);
    }
  }, [clearSignal]);

  // Load single-frame mask overlay (used after segmentation, shown while paused)
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

    // Single-frame mask overlay (only meaningful while paused on the segmented frame)
    if (maskImage && isPaused) {
      ctx.globalAlpha = 0.35;
      ctx.drawImage(maskImage, rect.offsetX, rect.offsetY, rect.dw, rect.dh);
      ctx.globalAlpha = 1;
    }

    // Positive points
    annotations.positivePoints.forEach(p => {
      const cp = videoToCanvas(p.x, p.y);
      if (!cp) return;
      ctx.beginPath();
      ctx.arc(cp.x, cp.y, 6, 0, Math.PI * 2);
      ctx.fillStyle = 'hsl(142 70% 42%)';
      ctx.fill();
      ctx.strokeStyle = 'hsl(142 70% 55%)';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cp.x - 3, cp.y); ctx.lineTo(cp.x + 3, cp.y);
      ctx.moveTo(cp.x, cp.y - 3); ctx.lineTo(cp.x, cp.y + 3);
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    });

    // Negative points
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
      ctx.strokeStyle = 'hsl(142 70% 50%)';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 3]);
      ctx.strokeRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
      ctx.setLineDash([]);
    });

    // Completed polygons
    annotations.polygons.forEach(poly => {
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
      ctx.strokeStyle = 'hsl(142 70% 50%)';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = 'hsla(142, 70%, 50%, 0.1)';
      ctx.fill();
    });

    // In-progress box
    if (drawingBox) {
      const s = videoToCanvas(drawingBox.start.x, drawingBox.start.y);
      const c = videoToCanvas(drawingBox.current.x, drawingBox.current.y);
      if (s && c) {
        ctx.strokeStyle = 'hsl(185 70% 50%)';
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
        ctx.strokeStyle = 'hsl(142 70% 50%)';
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 4]);
        ctx.stroke();
        ctx.setLineDash([]);
        currentPolygon.forEach(pt => {
          const p = videoToCanvas(pt.x, pt.y);
          if (!p) return;
          ctx.beginPath();
          ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
          ctx.fillStyle = 'hsl(142 70% 50%)';
          ctx.fill();
        });
      }
    }
  }, [annotations, drawingBox, currentPolygon, maskImage, isPaused, videoToCanvas, getDisplayRect]);

  useEffect(() => { drawCanvas(); }, [drawCanvas]);

  // Frame index sync during playback
  useEffect(() => {
    if (isPaused) return;
    const video = videoRef.current;
    if (!video) return;
    const interval = setInterval(() => {
      onFrameIdxChange(Math.floor(video.currentTime * (fps || 30)));
    }, 100);
    return () => clearInterval(interval);
  }, [isPaused, fps, onFrameIdxChange]);

  // Resize observer
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const ro = new ResizeObserver(() => drawCanvas());
    ro.observe(container);
    return () => ro.disconnect();
  }, [drawCanvas]);

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) { video.play(); onPausedChange(false); }
    else { video.pause(); onPausedChange(true); }
  };

  const handleSeek = (value: number[]) => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = value[0];
    setCurrentTime(value[0]);
    onFrameIdxChange(Math.floor(value[0] * (fps || 30)));
    drawCanvas();
  };

  const getCanvasCoords = (e: React.MouseEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return { cx: e.clientX - rect.left, cy: e.clientY - rect.top };
  };

  const handleCanvasClick = (e: React.MouseEvent) => {
    if (!isPaused || activeTool === 'none') return;
    const coords = getCanvasCoords(e);
    if (!coords) return;
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
    if (!isPaused || activeTool !== 'box') return;
    const coords = getCanvasCoords(e);
    if (!coords) return;
    const vp = canvasToVideo(coords.cx, coords.cy);
    if (!vp) return;
    setDrawingBox({ start: vp, current: vp });
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!drawingBox) return;
    const coords = getCanvasCoords(e);
    if (!coords) return;
    const vp = canvasToVideo(coords.cx, coords.cy);
    if (!vp) return;
    setDrawingBox(prev => prev ? { ...prev, current: vp } : null);
  };

  const handleMouseUp = () => {
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

  const cursorClass = isPaused && activeTool !== 'none' ? 'cursor-crosshair' : 'cursor-default';

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
          }}
          onTimeUpdate={(e) => {
            const t = e.currentTarget.currentTime;
            setCurrentTime(t);
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