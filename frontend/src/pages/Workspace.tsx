import { useState, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Brain, ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { useToast } from '@/hooks/use-toast';
import VideoSelector from '@/components/VideoSelector';
import VideoPlayer, { type Annotations, type Point } from '@/components/VideoPlayer';
import AnnotationToolbar from '@/components/AnnotationToolbar';
import {
  uploadVideo,
  selectVideo,
  segmentFramePoints,
  segmentFrameMask,
  propagate,
  renderMaskedVideo,
  getVideoStreamUrl,
  API_BASE,
} from '@/lib/api';

type Tool = 'none' | 'positive' | 'negative' | 'box' | 'polygon';
type Status = 'idle' | 'uploading' | 'selecting' | 'ready' | 'segmenting' | 'segmented' | 'tracking' | 'tracked';

const emptyAnnotations: Annotations = {
  positivePoints: [],
  negativePoints: [],
  boxes: [],
  polygons: [],
};

function polygonToBinaryMaskB64(polygons: Point[][], width: number, height: number): string {
  const offscreen = document.createElement('canvas');
  offscreen.width = width;
  offscreen.height = height;
  const ctx = offscreen.getContext('2d')!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#fff';
  for (const poly of polygons) {
    if (poly.length < 3) continue;
    ctx.beginPath();
    ctx.moveTo(poly[0].x, poly[0].y);
    for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i].x, poly[i].y);
    ctx.closePath();
    ctx.fill();
  }
  return offscreen.toDataURL('image/png').split(',')[1];
}

const Workspace = () => {
  const navigate = useNavigate();
  const { toast } = useToast();

  const [status, setStatus] = useState<Status>('idle');
  const [videoUrl, setVideoUrl] = useState('');
  const [originalVideoUrl, setOriginalVideoUrl] = useState('');
  const [maskedVideoUrl, setMaskedVideoUrl] = useState<string | null>(null);
  const [showingMasked, setShowingMasked] = useState(false);
  const [isRenderingMasked, setIsRenderingMasked] = useState(false);
  const [videoName, setVideoName] = useState('');
  const [videoSize, setVideoSize] = useState({ w: 0, h: 0 });
  const [fps, setFps] = useState(30);
  const [frameIdx, setFrameIdx] = useState(0);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [trackingProgress, setTrackingProgress] = useState(0);
  const [activeTool, setActiveTool] = useState<Tool>('none');
  const [annotations, setAnnotations] = useState<Annotations>(emptyAnnotations);
  const [maskUrl, setMaskUrl] = useState<string | null>(null);
  const [isPaused, setIsPaused] = useState(true);
  const [hasTracked, setHasTracked] = useState(false);
  const [hasSegmented, setHasSegmented] = useState(false);
  const [clearSignal, setClearSignal] = useState(0);

  // Keep currentTime in a ref so the masked video toggle can seek to the same position
  const currentTimeRef = useRef(0);

  const handleFrameIdxChange = useCallback((idx: number) => {
    setFrameIdx(idx);
    currentTimeRef.current = idx / fps;
  }, [fps]);

  const setAndRememberVideoUrl = (url: string) => {
    setOriginalVideoUrl(url);
    setVideoUrl(url);
  };

  const handleSelectExisting = useCallback(async (name: string) => {
    setStatus('selecting');
    try {
      const info = await selectVideo(name);
      setVideoName(info.video_name);
      setFps(info.fps || 30);
      setAndRememberVideoUrl(getVideoStreamUrl(info.video_name));
      setStatus('ready');
      toast({ title: 'Video Loaded', description: `"${info.video_name}" ready (${info.total_frames} frames).` });
    } catch {
      toast({ title: 'Selection Failed', description: 'Could not load video from server.', variant: 'destructive' });
      setStatus('idle');
    }
  }, [toast]);

  const handleUploadNew = useCallback(async (file: File, name: string) => {
    setStatus('uploading');
    setUploadProgress(0);
    try {
      const result = await uploadVideo(file, name, (p) => setUploadProgress(p));
      setVideoName(result.video_name);
      setFps(result.fps || 30);
      setAndRememberVideoUrl(getVideoStreamUrl(result.video_name));
      setStatus('ready');
      toast({ title: 'Upload Complete', description: `${result.total_frames} frames extracted.` });
    } catch (err: any) {
      toast({ title: 'Upload Failed', description: err.message || 'Could not upload to backend.', variant: 'destructive' });
      setStatus('idle');
    }
  }, [toast]);

  const hasPolygons = annotations.polygons.length > 0;
  const hasPointsOrBox =
    annotations.positivePoints.length > 0 ||
    annotations.negativePoints.length > 0 ||
    annotations.boxes.length > 0;
  const canSegment = hasPolygons || hasPointsOrBox;

  const handleSegment = useCallback(async () => {
    if (!canSegment) return;
    setStatus('segmenting');
    try {
      let result;
      if (hasPolygons) {
        const maskB64 = polygonToBinaryMaskB64(annotations.polygons, videoSize.w, videoSize.h);
        result = await segmentFrameMask({ video_name: videoName, frame_idx: frameIdx, obj_id: 1, mask_b64: maskB64 });
      } else {
        const lastBox = annotations.boxes.length > 0
          ? (() => { const b = annotations.boxes[annotations.boxes.length - 1]; return [b.x1, b.y1, b.x2, b.y2]; })()
          : null;
        result = await segmentFramePoints({
          video_name: videoName, frame_idx: frameIdx, obj_id: 1,
          positive_points: annotations.positivePoints.map(p => [p.x, p.y]),
          negative_points: annotations.negativePoints.map(p => [p.x, p.y]),
          box: lastBox,
        });
      }
      if (result) setMaskUrl(`${API_BASE}${result.mask_path}?t=${Date.now()}`);
      setStatus('segmented');
      setHasSegmented(true);
      toast({ title: 'Segmentation Complete', description: 'Mask generated successfully.' });
    } catch (err: any) {
      toast({ title: 'Segmentation Failed', description: err.message || 'Could not run segmentation.', variant: 'destructive' });
      setStatus('ready');
    }
  }, [videoName, frameIdx, annotations, canSegment, hasPolygons, videoSize, toast]);

  const handleTrack = useCallback(async () => {
    setStatus('tracking');
    setTrackingProgress(0);
    try {
      const progressInterval = setInterval(() => {
        setTrackingProgress(prev => Math.min(prev + Math.random() * 8, 90));
      }, 600);
      const result = await propagate(videoName, frameIdx, frameIdx + 50);
      clearInterval(progressInterval);
      setTrackingProgress(100);
      setStatus('tracked');
      setHasTracked(true);
      // Reset masked video state — new tracking run invalidates old render
      setMaskedVideoUrl(null);
      setShowingMasked(false);
      toast({ title: 'Tracking Complete', description: `${result.total_masks_saved} masks propagated.` });
    } catch {
      toast({ title: 'Tracking Failed', description: 'Propagation failed.', variant: 'destructive' });
      setStatus('segmented');
    }
  }, [videoName, frameIdx, toast]);

  const handleRenderMaskedVideo = useCallback(async () => {
    setIsRenderingMasked(true);
    try {
      const result = await renderMaskedVideo(videoName);
      const url = `${API_BASE}${result.video_url}?t=${Date.now()}`;
      setMaskedVideoUrl(url);
      // Switch to masked view immediately
      setVideoUrl(url);
      setShowingMasked(true);
      toast({ title: 'Masked Video Ready', description: 'Showing masked video.' });
    } catch (err: any) {
      toast({ title: 'Render Failed', description: err.message || 'Could not render masked video.', variant: 'destructive' });
    } finally {
      setIsRenderingMasked(false);
    }
  }, [videoName, toast]);

  const handleToggleMaskedVideo = useCallback(() => {
    if (!maskedVideoUrl) return;
    if (showingMasked) {
      setVideoUrl(originalVideoUrl);
      setShowingMasked(false);
    } else {
      setVideoUrl(maskedVideoUrl);
      setShowingMasked(true);
    }
  }, [showingMasked, maskedVideoUrl, originalVideoUrl]);

  const handleClear = () => {
    setAnnotations(emptyAnnotations);
    setMaskUrl(null);
    setActiveTool('none');
    setHasSegmented(false);
    setHasTracked(false);
    setMaskedVideoUrl(null);
    setShowingMasked(false);
    setVideoUrl(originalVideoUrl);
    setClearSignal(prev => prev + 1);
    if (status === 'segmented' || status === 'tracked') setStatus('ready');
  };

  const showSelector = status === 'idle' || status === 'uploading' || status === 'selecting';
  const showPlayer = !showSelector;

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <header className="flex items-center justify-between px-6 py-3 border-b border-border bg-card/50 backdrop-blur-sm">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => navigate('/')}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="flex items-center gap-2">
            <Brain className="h-5 w-5 text-primary" />
            <span className="font-semibold text-foreground">MedSeg Vision</span>
          </div>
        </div>
        {videoName && (
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span>Video: <span className="font-mono text-primary">{videoName}</span></span>
            {showingMasked && (
              <span className="px-2 py-0.5 rounded-full bg-primary/20 text-primary font-medium text-xs">
                masked
              </span>
            )}
            <span className="px-2 py-0.5 rounded-full bg-primary/10 text-primary font-medium capitalize">
              {status}
            </span>
            {showPlayer && (
              <Button
                variant="ghost"
                size="sm"
                className="text-xs"
                onClick={() => {
                  setStatus('idle');
                  setVideoUrl('');
                  setOriginalVideoUrl('');
                  setVideoName('');
                  setMaskedVideoUrl(null);
                  setShowingMasked(false);
                  handleClear();
                }}
              >
                Change Video
              </Button>
            )}
          </div>
        )}
      </header>

      <main className="flex-1 flex items-center justify-center p-6">
        {showSelector && (
          <VideoSelector
            onSelectExisting={handleSelectExisting}
            onUploadNew={handleUploadNew}
            uploadProgress={uploadProgress}
            isUploading={status === 'uploading'}
            isSelecting={status === 'selecting'}
          />
        )}

        {showPlayer && (
          <div className="w-full max-w-7xl flex flex-col gap-4">
            <div className="w-full">
              <VideoPlayer
                videoUrl={videoUrl}
                activeTool={activeTool}
                annotations={annotations}
                onAnnotationsChange={setAnnotations}
                maskUrl={showingMasked ? null : maskUrl}
                fps={fps}
                onFrameIdxChange={handleFrameIdxChange}
                isPaused={isPaused}
                onPausedChange={setIsPaused}
                clearSignal={clearSignal}
                onVideoSizeChange={setVideoSize}
              />

              {status === 'tracking' && (
                <div className="mt-4 p-4 rounded-lg border border-border bg-card">
                  <div className="flex justify-between text-sm mb-2">
                    <span className="text-foreground font-medium">Propagating masks…</span>
                    <span className="text-primary font-mono">{Math.round(trackingProgress)}%</span>
                  </div>
                  <Progress value={trackingProgress} className="h-2" />
                </div>
              )}

              {isRenderingMasked && (
                <div className="mt-4 p-4 rounded-lg border border-border bg-card">
                  <div className="flex justify-between text-sm mb-2">
                    <span className="text-foreground font-medium">Rendering masked video…</span>
                    <span className="text-primary font-mono text-xs">this may take a moment</span>
                  </div>
                  <Progress value={undefined} className="h-2 animate-pulse" />
                </div>
              )}
            </div>

            <AnnotationToolbar
              activeTool={activeTool}
              onToolChange={setActiveTool}
              onSegment={handleSegment}
              onTrack={handleTrack}
              onClear={handleClear}
              onRenderMaskedVideo={handleRenderMaskedVideo}
              onToggleMaskedVideo={handleToggleMaskedVideo}
              canSegment={canSegment}
              canTrack={hasSegmented}
              canRenderMasked={hasTracked}
              isSegmenting={status === 'segmenting'}
              isTracking={status === 'tracking'}
              isRenderingMasked={isRenderingMasked}
              showingMasked={showingMasked}
              maskedVideoReady={maskedVideoUrl !== null}
              isPaused={isPaused}
            />
          </div>
        )}
      </main>
    </div>
  );
};

export default Workspace;