import { useState, useCallback, useRef, useEffect } from 'react';
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
  uploadVideo,
  selectVideo,
  segmentFramePoints,
  segmentFrameMask,
  propagate,
  renderMaskedVideo,
  getVideoStreamUrl,
  getObjectLabels,
  getMaskPolygons,
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

// Palette of distinct colours for objects (hex for UI, rgb for API)
export const OBJECT_PALETTE: { hex: string; r: number; g: number; b: number }[] = [
  { hex: '#1d9e75', r: 29,  g: 158, b: 117 },
  { hex: '#3b63eb', r: 59,  g: 99,  b: 235 },
  { hex: '#f97316', r: 249, g: 115, b: 22  },
  { hex: '#dc2626', r: 220, g: 38,  b: 38  },
  { hex: '#9333ea', r: 147, g: 51,  b: 234 },
  { hex: '#0891b2', r: 8,   g: 145, b: 178 },
  { hex: '#db2777', r: 219, g: 39,  b: 119 },
  { hex: '#ca8a04', r: 202, g: 138, b: 4   },
];

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
  const [isPaused, setIsPaused] = useState(true);
  const [hasTracked, setHasTracked] = useState(false);
  const [clearSignal, setClearSignal] = useState(0);
  const [hidePrompts, setHidePrompts] = useState(false);
  const [isGettingPolygons, setIsGettingPolygons] = useState(false);

  // ── Multi-object state ────────────────────────────────────────────────────
  // Each TrackedObject has { id, label, color } where id is the SAM-2 obj_id.
  const [objects, setObjects] = useState<TrackedObject[]>([
    { id: 1, label: 'Object 1', color: OBJECT_PALETTE[0] },
  ]);
  const [activeObjectId, setActiveObjectId] = useState<number>(1);

  // Per-object annotations map: obj_id → Annotations
  const [annotationsMap, setAnnotationsMap] = useState<Record<number, Annotations>>({
    1: emptyAnnotations,
  });

  // Per-object mask URLs (from segmentation): obj_id → url
  const [maskUrlMap, setMaskUrlMap] = useState<Record<number, string | null>>({});

  // Per-object "has been segmented" flag
  const [segmentedObjects, setSegmentedObjects] = useState<Set<number>>(new Set());

  // Current annotations for the active object (convenience alias)
  const annotations = annotationsMap[activeObjectId] ?? emptyAnnotations;
  const setAnnotations = useCallback((a: Annotations) => {
    setAnnotationsMap(prev => ({ ...prev, [activeObjectId]: a }));
  }, [activeObjectId]);

  // Mask URL for the active object
  const activeMaskUrl = maskUrlMap[activeObjectId] ?? null;

  const currentTimeRef = useRef(0);
  const seekToRef = useRef<((time: number) => void) | null>(null);

  // ── Object management ─────────────────────────────────────────────────────

  const handleAddObject = useCallback((label: string) => {
    const newId = Math.max(...objects.map(o => o.id)) + 1;
    const color = OBJECT_PALETTE[(newId - 1) % OBJECT_PALETTE.length];
    const newObj: TrackedObject = { id: newId, label, color };
    setObjects(prev => [...prev, newObj]);
    setAnnotationsMap(prev => ({ ...prev, [newId]: emptyAnnotations }));
    setActiveObjectId(newId);
    setActiveTool('none');
  }, [objects]);

  const handleRemoveObject = useCallback((id: number) => {
    setObjects(prev => {
      const remaining = prev.filter(o => o.id !== id);
      if (remaining.length === 0) return prev; // always keep at least one
      return remaining;
    });
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
    setActiveObjectId(prev => (prev === id ? objects.find(o => o.id !== id)?.id ?? 1 : prev));
  }, [objects]);

  const handleRenameObject = useCallback((id: number, label: string) => {
    setObjects(prev => prev.map(o => o.id === id ? { ...o, label } : o));
  }, []);

  // ── Video loading & Object restoration ────────────────────────────────────

  const handleFrameIdxChange = useCallback((idx: number) => setFrameIdx(idx), []);
  const handleCurrentTimeChange = useCallback((t: number) => { currentTimeRef.current = t; }, []);

  const setAndRememberVideoUrl = (url: string) => {
    setOriginalVideoUrl(url);
    setVideoUrl(url);
  };

  /**
   * Restore objects from existing mask files when selecting a video
   */
  const restoreObjectsFromMasks = useCallback(async (name: string) => {
    try {
      const { objects: labelMap } = await getObjectLabels(name);
      
      if (Object.keys(labelMap).length > 0) {
        // Build TrackedObject array from label map
        const restoredObjects: TrackedObject[] = [];
        const restoredAnnotationsMap: Record<number, Annotations> = {};
        
        for (const [objIdStr, label] of Object.entries(labelMap)) {
          const objId = parseInt(objIdStr, 10);
          const color = OBJECT_PALETTE[(objId - 1) % OBJECT_PALETTE.length];
          restoredObjects.push({ id: objId, label, color });
          restoredAnnotationsMap[objId] = emptyAnnotations;
        }
        
        // Sort by id
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
      // If restoration fails, keep default single object
    }
  }, [toast]);

  const handleSelectExisting = useCallback(async (name: string) => {
    setStatus('selecting');
    try {
      const info = await selectVideo(name);
      setVideoName(info.video_name);
      setFps(info.fps || 30);
      setAndRememberVideoUrl(getVideoStreamUrl(info.video_name));
      
      // Restore objects from existing masks
      await restoreObjectsFromMasks(info.video_name);
      
      setStatus('ready');
      toast({ title: 'Video Loaded', description: `"${info.video_name}" ready (${info.total_frames} frames).` });
    } catch {
      toast({ title: 'Selection Failed', description: 'Could not load video from server.', variant: 'destructive' });
      setStatus('idle');
    }
  }, [toast, restoreObjectsFromMasks]);

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

  // ── Segmentation ──────────────────────────────────────────────────────────

  const hasPolygons = annotations.polygons.length > 0;
  const hasPointsOrBox =
    annotations.positivePoints.length > 0 ||
    annotations.negativePoints.length > 0 ||
    annotations.boxes.length > 0;
  const canSegment = hasPolygons || hasPointsOrBox;

  const handleSegment = useCallback(async () => {
    if (!canSegment) return;
    setStatus('segmenting');
    
    // Get the current object's label
    const currentObject = objects.find(o => o.id === activeObjectId);
    const objLabel = currentObject?.label ?? `Object ${activeObjectId}`;
    
    try {
      let result;
      if (hasPolygons) {
        const maskB64 = polygonToBinaryMaskB64(annotations.polygons, videoSize.w, videoSize.h);
        result = await segmentFrameMask({
          video_name: videoName,
          frame_idx: frameIdx,
          obj_id: activeObjectId,
          obj_label: objLabel,  // Include label
          mask_b64: maskB64,
        });
      } else {
        const lastBox = annotations.boxes.length > 0
          ? (() => { const b = annotations.boxes[annotations.boxes.length - 1]; return [b.x1, b.y1, b.x2, b.y2]; })()
          : null;
        result = await segmentFramePoints({
          video_name: videoName,
          frame_idx: frameIdx,
          obj_id: activeObjectId,
          obj_label: objLabel,  // Include label
          positive_points: annotations.positivePoints.map(p => [p.x, p.y]),
          negative_points: annotations.negativePoints.map(p => [p.x, p.y]),
          box: lastBox,
        });
      }
      if (result) {
        setMaskUrlMap(prev => ({
          ...prev,
          [activeObjectId]: `${API_BASE}${result.mask_path}?t=${Date.now()}`,
        }));
      }
      setSegmentedObjects(prev => new Set(prev).add(activeObjectId));
      setStatus('segmented');
      toast({ title: 'Segmentation Complete', description: `Mask for "${objLabel}" ready.` });
    } catch (err: any) {
      toast({ title: 'Segmentation Failed', description: err.message || 'Could not run segmentation.', variant: 'destructive' });
      setStatus('ready');
    }
  }, [videoName, frameIdx, annotations, canSegment, hasPolygons, videoSize, activeObjectId, objects, toast]);

  // ── Tracking ──────────────────────────────────────────────────────────────

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
      setHasTracked(true);
      setMaskedVideoUrl(null);
      setShowingMasked(false);
      toast({ title: 'Tracking Complete', description: `${result.total_masks_saved} masks propagated for ${segmentedObjects.size} object(s).` });
    } catch {
      toast({ title: 'Tracking Failed', description: 'Propagation failed.', variant: 'destructive' });
      setStatus('segmented');
    }
  }, [videoName, frameIdx, segmentedObjects.size, toast]);

  // ── Get Polygons (mask → editable polygon vertices) ───────────────────────

  const canGetPolygons = status !== 'idle' && status !== 'uploading' && status !== 'selecting';

  const handleGetPolygons = useCallback(async () => {
    setIsGettingPolygons(true);

    // If watching the masked video, switch back to the original first so the
    // polygon overlay is visible on the correct canvas.
    if (showingMasked) {
      const savedTime = currentTimeRef.current;
      setVideoUrl(originalVideoUrl);
      setShowingMasked(false);
      seekToRef.current = (seek: (t: number) => void) => seek(savedTime);
    }

    // Must be paused to annotate — pause the video if it's playing.
    setIsPaused(true);

    try {
      const { polygons } = await getMaskPolygons(videoName, frameIdx, activeObjectId);
      if (!polygons.length) {
        toast({
          title: 'No Polygons Found',
          description: 'No saved mask for this frame/object yet. Segment the frame first.',
          variant: 'destructive',
        });
        return;
      }

      // Load polygons into annotations — this also makes canSegment true
      setAnnotations({ ...annotations, polygons });

      // Mark this object as segmented so Track All stays enabled
      setSegmentedObjects(prev => new Set(prev).add(activeObjectId));

      // Switch to polygon tool so vertices are immediately visible and draggable
      setActiveTool('polygon');

      // Reflect segmented status if not already past it
      if (status === 'ready') setStatus('segmented');

      toast({
        title: 'Polygons Loaded',
        description: `${polygons.length} polygon${polygons.length > 1 ? 's' : ''} imported — drag any vertex to refine, then hit Segment.`,
      });
    } catch (err: any) {
      toast({
        title: 'Failed to Get Polygons',
        description: err.message || 'Could not fetch mask polygons.',
        variant: 'destructive',
      });
    } finally {
      setIsGettingPolygons(false);
    }
  }, [
    videoName, frameIdx, activeObjectId,
    annotations, setAnnotations,
    showingMasked, originalVideoUrl,
    status, toast,
  ]);

  // ── Masked video ──────────────────────────────────────────────────────────

  const handleRenderMaskedVideo = useCallback(async () => {
    setIsRenderingMasked(true);
    const savedTime = currentTimeRef.current;

    // Build obj_colors map: obj_id (string) → { r, g, b }
    const obj_colors: Record<string, { r: number; g: number; b: number }> = {};
    for (const obj of objects) {
      obj_colors[String(obj.id)] = { r: obj.color.r, g: obj.color.g, b: obj.color.b };
    }

    try {
      const result = await renderMaskedVideo(videoName, obj_colors);
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
  }, [videoName, objects, toast]);

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

  // ── Clear ─────────────────────────────────────────────────────────────────

  const handleClear = () => {
    // Clear annotations only for the active object
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
    setHasTracked(false);
    setMaskedVideoUrl(null);
    if (showingMasked) {
      setVideoUrl(originalVideoUrl);
      setShowingMasked(false);
    }
    setClearSignal(prev => prev + 1);
    if (status !== 'idle' && status !== 'uploading' && status !== 'selecting') setStatus('ready');
  };

  // ── Render ────────────────────────────────────────────────────────────────

  const showSelector = status === 'idle' || status === 'uploading' || status === 'selecting';
  const showPlayer = !showSelector;

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
            {showPlayer && (
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

        {showPlayer && (
          <div className="w-full max-w-7xl flex flex-col gap-4">
            {/* Object manager panel */}
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
                onFrameIdxChange={handleFrameIdxChange}
                onCurrentTimeChange={handleCurrentTimeChange}
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