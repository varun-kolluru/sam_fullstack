import { useState, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Brain, ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { useToast } from '@/hooks/use-toast';
import VideoSelector from '@/components/VideoSelector';
import VideoPlayer, { type Annotations, type Point } from '@/components/VideoPlayer';
import AnnotationToolbar from '@/components/AnnotationToolbar';
import ObjectManager, { type TrackedObject } from '@/components/ObjectManager';
import {
  uploadVideo, selectVideo, segmentFrame, propagate,
  renderMaskedVideo, getVideoStreamUrl, getObjectLabels, getMaskPolygons, API_BASE,
} from '@/lib/api';

type Tool = 'none' | 'positive' | 'negative' | 'box' | 'polygon';
type Status = 'idle' | 'uploading' | 'selecting' | 'ready' | 'segmenting' | 'segmented' | 'tracking' | 'tracked';

const emptyAnnotations: Annotations = {
  positivePoints: [],
  negativePoints: [],
  boxes: [],
  polygons: [],
};

export const OBJECT_PALETTE: { hex: string; r: number; g: number; b: number }[] = [
  { hex: '#1d9e75', r: 29, g: 158, b: 117 },
  { hex: '#3b63eb', r: 59, g: 99, b: 235 },
  { hex: '#f97316', r: 249, g: 115, b: 22 },
  { hex: '#dc2626', r: 220, g: 38, b: 38 },
  { hex: '#9333ea', r: 147, g: 51, b: 234 },
  { hex: '#0891b2', r: 8, g: 145, b: 178 },
  { hex: '#db2777', r: 219, g: 39, b: 119 },
  { hex: '#ca8a04', r: 202, g: 138, b: 4 },
];

function polygonToBinaryMaskB64(polygons: Point[][], width: number, height: number): string {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
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
  return canvas.toDataURL('image/png').split(',')[1];
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
  const [isPaused, setIsPaused] = useState(true);
  const [clearSignal, setClearSignal] = useState(0);
  const [hidePrompts, setHidePrompts] = useState(false);
  const [isGettingPolygons, setIsGettingPolygons] = useState(false);

  // Multi-object state
  const [objects, setObjects] = useState<TrackedObject[]>([
    { id: 1, label: 'Object 1', color: OBJECT_PALETTE[0] },
  ]);
  const [activeObjectId, setActiveObjectId] = useState(1);
  const [annotationsMap, setAnnotationsMap] = useState<Record<number, Annotations>>({ 1: emptyAnnotations });
  const [maskUrlMap, setMaskUrlMap] = useState<Record<number, string | null>>({});
  const [segmentedObjects, setSegmentedObjects] = useState<Set<number>>(new Set());

  const annotations = annotationsMap[activeObjectId] ?? emptyAnnotations;
  const setAnnotations = useCallback((a: Annotations) => {
    setAnnotationsMap(prev => ({ ...prev, [activeObjectId]: a }));
  }, [activeObjectId]);

  const activeMaskUrl = maskUrlMap[activeObjectId] ?? null;
  const currentTimeRef = useRef(0);
  const seekToRef = useRef<((time: number) => void) | null>(null);

  // ── Object management ────────────────────────────────────────────────────
  const handleAddObject = useCallback((label: string) => {
    const newId = Math.max(...objects.map(o => o.id)) + 1;
    const newObj: TrackedObject = {
      id: newId,
      label,
      color: OBJECT_PALETTE[(newId - 1) % OBJECT_PALETTE.length],
    };
    setObjects(prev => [...prev, newObj]);
    setAnnotationsMap(prev => ({ ...prev, [newId]: emptyAnnotations }));
    setActiveObjectId(newId);
    setActiveTool('none');
  }, [objects]);

  const handleRemoveObject = useCallback((id: number) => {
    const remaining = objects.filter(o => o.id !== id);
    if (remaining.length === 0) return;

    setObjects(remaining);
    setAnnotationsMap(prev => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setMaskUrlMap(prev => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setSegmentedObjects(prev => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    setActiveObjectId(prev => (prev === id ? remaining[0].id : prev));
  }, [objects]);

  const handleRenameObject = useCallback((id: number, label: string) => {
    setObjects(prev => prev.map(o => o.id === id ? { ...o, label } : o));
  }, []);

  // ── Object restoration ──────────────────────────────────────────────────
  const restoreObjectsFromMasks = useCallback(async (name: string) => {
    try {
      const { objects: labelMap } = await getObjectLabels(name);
      if (Object.keys(labelMap).length > 0) {
        const restoredObjects: TrackedObject[] = [];
        const restoredAnnotationsMap: Record<number, Annotations> = {};

        for (const [objIdStr, label] of Object.entries(labelMap)) {
          const objId = parseInt(objIdStr, 10);
          restoredObjects.push({
            id: objId,
            label,
            color: OBJECT_PALETTE[(objId - 1) % OBJECT_PALETTE.length],
          });
          restoredAnnotationsMap[objId] = emptyAnnotations;
        }

        restoredObjects.sort((a, b) => a.id - b.id);
        setObjects(restoredObjects);
        setAnnotationsMap(restoredAnnotationsMap);
        setActiveObjectId(restoredObjects[0]?.id ?? 1);

        toast({
          title: 'Objects Restored',
          description: `Found ${restoredObjects.length} existing object(s) with masks.`,
        });
      }
    } catch (err) {
      console.error('Failed to restore objects:', err);
    }
  }, [toast]);

  // ── Video loading ────────────────────────────────────────────────────────
  const setAndRememberVideoUrl = (url: string) => {
    setOriginalVideoUrl(url);
    setVideoUrl(url);
  };

  const handleSelectExisting = useCallback(async (name: string, selectedFps?: number) => {
    setStatus('selecting');
    try {
      const info = await selectVideo(name, selectedFps);
      setVideoName(info.video_name);
      setFps(info.fps || 30);
      setAndRememberVideoUrl(getVideoStreamUrl(info.video_name));
      await restoreObjectsFromMasks(info.video_name);
      setStatus('ready');
      toast({ title: 'Video Loaded', description: `"${info.video_name}" ready (${info.total_frames} frames).` });
    } catch {
      toast({ title: 'Selection Failed', description: 'Could not load video.', variant: 'destructive' });
      setStatus('idle');
    }
  }, [toast, restoreObjectsFromMasks]);

  const handleUploadNew = useCallback(async (file: File, name: string, selectedFps?: number) => {
    setStatus('uploading');
    setUploadProgress(0);
    try {
      const result = await uploadVideo(file, name, selectedFps, (p) => setUploadProgress(p));
      setVideoName(result.video_name);
      setFps(result.fps || 30);
      setAndRememberVideoUrl(getVideoStreamUrl(result.video_name));
      setStatus('ready');
      toast({ title: 'Upload Complete', description: `${result.total_frames} frames extracted.` });
    } catch (err: any) {
      toast({ title: 'Upload Failed', description: err.message || 'Upload failed.', variant: 'destructive' });
      setStatus('idle');
    }
  }, [toast]);

  // ── Segmentation ──────────────────────────────────────────────────────────
  const hasPolygons = annotations.polygons.length > 0;
  const hasPointsOrBox = annotations.positivePoints.length > 0 || annotations.negativePoints.length > 0 || annotations.boxes.length > 0;
  const canSegment = hasPolygons || hasPointsOrBox;

  const handleSegment = useCallback(async () => {
    if (!canSegment) return;
    setStatus('segmenting');

    const objLabel = objects.find(o => o.id === activeObjectId)?.label ?? `Object ${activeObjectId}`;

    try {
      const requestBody: {
        video_name: string;
        frame_idx: number;
        obj_id: number;
        obj_label: string;
        positive_points?: number[][];
        negative_points?: number[][];
        box?: number[] | null;
        mask_b64?: string;
      } = {
        video_name: videoName,
        frame_idx: frameIdx,
        obj_id: activeObjectId,
        obj_label: objLabel,
      };

      // Add mask if polygons exist
      if (hasPolygons) {
        requestBody.mask_b64 = polygonToBinaryMaskB64(
          annotations.polygons,
          videoSize.w,
          videoSize.h
        );
      }

      // Add points if they exist
      if (annotations.positivePoints.length > 0) {
        requestBody.positive_points = annotations.positivePoints.map(p => [p.x, p.y]);
      }
      if (annotations.negativePoints.length > 0) {
        requestBody.negative_points = annotations.negativePoints.map(p => [p.x, p.y]);
      }

      // Add box if it exists
      if (annotations.boxes.length > 0) {
        const b = annotations.boxes[annotations.boxes.length - 1];
        requestBody.box = [b.x1, b.y1, b.x2, b.y2];
      }

      const result = await segmentFrame(requestBody);

      if (result) {
        setMaskUrlMap(prev => ({
          ...prev,
          [activeObjectId]: `${API_BASE}${result.mask_path}?t=${Date.now()}`,
        }));
      }
      setSegmentedObjects(prev => new Set(prev).add(activeObjectId));
      setStatus('segmented');
      toast({
        title: 'Segmentation Complete',
        description: `Mask for "${objLabel}" ready.`
      });
    } catch (err: any) {
      toast({
        title: 'Segmentation Failed',
        description: err.message || 'Segmentation failed.',
        variant: 'destructive'
      });
      setStatus('ready');
    }
  }, [videoName, frameIdx, annotations, canSegment, hasPolygons, videoSize, activeObjectId, objects, toast]);

  // ── Tracking ───────────────────────────────────────────────────────────────
  const canTrack = segmentedObjects.size > 0;

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
      setMaskedVideoUrl(null);
      setShowingMasked(false);
      toast({ title: 'Tracking Complete', description: `${result.total_masks_saved} masks propagated for ${segmentedObjects.size} object(s).` });
    } catch {
      toast({ title: 'Tracking Failed', description: 'Propagation failed.', variant: 'destructive' });
      setStatus('segmented');
    }
  }, [videoName, frameIdx, segmentedObjects.size, toast]);

  // ── Get Polygons ────────────────────────────────────────────────────────────
  const canGetPolygons = status !== 'idle' && status !== 'uploading' && status !== 'selecting';

  const handleGetPolygons = useCallback(async () => {
    setIsGettingPolygons(true);

    if (showingMasked) {
      const savedTime = currentTimeRef.current;
      setVideoUrl(originalVideoUrl);
      setShowingMasked(false);
      seekToRef.current = (seek: (t: number) => void) => seek(savedTime);
    }

    setIsPaused(true);

    try {
      const { polygons } = await getMaskPolygons(videoName, frameIdx, activeObjectId);
      if (!polygons.length) {
        toast({
          title: 'No Polygons Found',
          description: 'No saved mask yet. Segment first.',
          variant: 'destructive',
        });
        return;
      }

      setAnnotations({ ...annotations, polygons });
      setSegmentedObjects(prev => new Set(prev).add(activeObjectId));
      setActiveTool('polygon');
      if (status === 'ready') setStatus('segmented');

      toast({
        title: 'Polygons Loaded',
        description: `${polygons.length} polygon${polygons.length > 1 ? 's' : ''} imported — drag vertices to refine, then hit Segment.`,
      });
    } catch (err: any) {
      toast({
        title: 'Failed to Get Polygons',
        description: err.message || 'Could not fetch polygons.',
        variant: 'destructive',
      });
    } finally {
      setIsGettingPolygons(false);
    }
  }, [videoName, frameIdx, activeObjectId, annotations, setAnnotations, showingMasked, originalVideoUrl, status, toast]);

  // ── Masked video ─────────────────────────────────────────────────────────────
  const handleRenderMaskedVideo = useCallback(async () => {
    setIsRenderingMasked(true);
    const savedTime = currentTimeRef.current;

    const obj_colors: Record<string, { r: number; g: number; b: number }> = {};
    for (const obj of objects) {
      obj_colors[String(obj.id)] = { r: obj.color.r, g: obj.color.g, b: obj.color.b };
    }

    try {
      const result = await renderMaskedVideo(videoName, obj_colors, 0.45, fps);
      const url = `${API_BASE}${result.video_url}?t=${Date.now()}`;
      setMaskedVideoUrl(url);
      setVideoUrl(url);
      setShowingMasked(true);
      seekToRef.current = (seek) => seek(savedTime);
      toast({ title: 'Masked Video Ready', description: 'Showing masked video.' });
    } catch (err: any) {
      toast({ title: 'Render Failed', description: err.message || 'Could not render masked video.', variant: 'destructive' });
    } finally {
      setIsRenderingMasked(false);
    }
  }, [videoName, objects, toast, fps]);

  const handleToggleMaskedVideo = useCallback(() => {
    if (!maskedVideoUrl) return;
    const savedTime = currentTimeRef.current;
    if (showingMasked) {
      setVideoUrl(originalVideoUrl);
      setShowingMasked(false);
    } else {
      setVideoUrl(maskedVideoUrl);
      setShowingMasked(true);
    }
    seekToRef.current = (seek: (t: number) => void) => seek(savedTime);
  }, [showingMasked, maskedVideoUrl, originalVideoUrl]);

  // ── Clear ───────────────────────────────────────────────────────────────────
  const handleClear = () => {
    setAnnotationsMap(prev => ({ ...prev, [activeObjectId]: emptyAnnotations }));
    setMaskUrlMap(prev => ({ ...prev, [activeObjectId]: null }));
    setActiveTool('none');
    setSegmentedObjects(prev => {
      const next = new Set(prev);
      next.delete(activeObjectId);
      return next;
    });
    if (showingMasked) {
      setVideoUrl(originalVideoUrl);
      setShowingMasked(false);
    }
    setClearSignal(prev => prev + 1);
    if (status === 'segmented') setStatus('ready');
  };

  const handleClearAll = () => {
    const fresh: Record<number, Annotations> = {};
    for (const obj of objects) fresh[obj.id] = emptyAnnotations;
    setAnnotationsMap(fresh);
    setMaskUrlMap({});
    setActiveTool('none');
    setSegmentedObjects(new Set());
    setMaskedVideoUrl(null);
    if (showingMasked) {
      setVideoUrl(originalVideoUrl);
      setShowingMasked(false);
    }
    setClearSignal(prev => prev + 1);
    if (status !== 'idle' && status !== 'uploading' && status !== 'selecting') setStatus('ready');
  };

  // ── Render ────────────────────────────────────────────────────────────────────
  const showSelector = status === 'idle' || status === 'uploading' || status === 'selecting';
  const activeObject = objects.find(o => o.id === activeObjectId);

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
              <span className="px-2 py-0.5 rounded-full bg-primary/20 text-primary font-medium text-xs">masked</span>
            )}
            <span className="px-2 py-0.5 rounded-full bg-primary/10 text-primary font-medium capitalize">{status}</span>
            {!showSelector && (
              <Button
                variant="ghost" size="sm" className="text-xs"
                onClick={() => {
                  setStatus('idle'); setVideoUrl(''); setOriginalVideoUrl('');
                  setVideoName(''); setMaskedVideoUrl(null); setShowingMasked(false);
                  handleClearAll();
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

        {!showSelector && (
          <div className="w-full max-w-7xl flex flex-col gap-4">
            <ObjectManager
              objects={objects}
              activeObjectId={activeObjectId}
              segmentedObjectIds={segmentedObjects}
              onSelect={id => { setActiveObjectId(id); setActiveTool('none'); }}
              onAdd={handleAddObject}
              onRemove={handleRemoveObject}
              onRename={handleRenameObject}
            />

            <div className="w-full">
              <VideoPlayer
                videoUrl={videoUrl}
                activeTool={activeTool}
                annotations={annotations}
                onAnnotationsChange={setAnnotations}
                maskUrl={showingMasked ? null : activeMaskUrl}
                maskColor={activeObject?.color.hex}
                fps={fps}
                onFrameIdxChange={setFrameIdx}
                onCurrentTimeChange={t => { currentTimeRef.current = t; }}
                isPaused={isPaused}
                onPausedChange={setIsPaused}
                clearSignal={clearSignal}
                onVideoSizeChange={setVideoSize}
                seekToRef={seekToRef}
                hidePrompts={hidePrompts}
                activeObjectColor={activeObject?.color.hex ?? '#1d9e75'}
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
              onGetPolygons={handleGetPolygons}
              canSegment={canSegment}
              canTrack={canTrack}
              canRenderMasked={status !== 'idle' && status !== 'uploading' && status !== 'selecting'}
              canGetPolygons={canGetPolygons}
              isSegmenting={status === 'segmenting'}
              isTracking={status === 'tracking'}
              isRenderingMasked={isRenderingMasked}
              isGettingPolygons={isGettingPolygons}
              showingMasked={showingMasked}
              maskedVideoReady={maskedVideoUrl !== null}
              isPaused={isPaused}
              hidePrompts={hidePrompts}
              onToggleHidePrompts={() => setHidePrompts(v => !v)}
              annotations={annotations}
              onAnnotationsChange={setAnnotations}
              activeObjectLabel={activeObject?.label ?? 'Object'}
              activeObjectColor={activeObject?.color.hex ?? '#1d9e75'}
            />
          </div>
        )}
      </main>
    </div>
  );
};

export default Workspace;