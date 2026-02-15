import { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Brain, ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { useToast } from '@/hooks/use-toast';
import VideoUploader from '@/components/VideoUploader';
import VideoPlayer, { type Annotations } from '@/components/VideoPlayer';
import AnnotationToolbar from '@/components/AnnotationToolbar';
import { uploadVideo, segmentFrame, propagateVideoMask, API_BASE } from '@/lib/api';

type Tool = 'none' | 'positive' | 'negative' | 'box' | 'polygon';
type Status = 'idle' | 'uploading' | 'extracting' | 'ready' | 'segmenting' | 'segmented' | 'tracking' | 'tracked';

const emptyAnnotations: Annotations = {
  positivePoints: [],
  negativePoints: [],
  boxes: [],
  polygons: [],
};

const Workspace = () => {
  const navigate = useNavigate();
  const { toast } = useToast();

  const [status, setStatus] = useState<Status>('idle');
  const [videoUrl, setVideoUrl] = useState<string>('');
  const [videoId, setVideoId] = useState<string>('');
  const [fps, setFps] = useState(30);
  const [frameIdx, setFrameIdx] = useState(0);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [extractionProgress, setExtractionProgress] = useState(0);
  const [trackingProgress, setTrackingProgress] = useState(0);
  const [activeTool, setActiveTool] = useState<Tool>('none');
  const [annotations, setAnnotations] = useState<Annotations>(emptyAnnotations);
  const [maskUrl, setMaskUrl] = useState<string | null>(null);
  const [masksFolder, setMasksFolder] = useState<string | null>(null);
  const [isPaused, setIsPaused] = useState(true);
  const [hasSegmented, setHasSegmented] = useState(false);
  const [clearSignal, setClearSignal] = useState(0);

  const handleUploadComplete = useCallback(async (file: File, localUrl: string) => {
    setVideoUrl(localUrl);
    setStatus('uploading');
    setUploadProgress(0);

    try {
      const result = await uploadVideo(file, (p) => setUploadProgress(p));
      setVideoId(result.video_id);
      setFps(result.fps || 30);
      setStatus('extracting');

      // Simulate extraction progress (in real app, poll backend)
      let progress = 0;
      const interval = setInterval(() => {
        progress += Math.random() * 15;
        if (progress >= 100) {
          progress = 100;
          clearInterval(interval);
          setStatus('ready');
        }
        setExtractionProgress(progress);
      }, 1);
    } catch (err) {
      toast({ title: 'Upload Failed', description: 'Could not connect to backend. Using local preview.', variant: 'destructive' });
      // Fallback: allow local preview without backend
      setVideoId('local-preview');
      setStatus('ready');
    }
  }, [toast]);

  const canSegment = annotations.positivePoints.length > 0 ||
    annotations.boxes.length > 0 ||
    annotations.polygons.length > 0;

  const handleSegment = useCallback(async () => {
    if (!canSegment) return;
    setStatus('segmenting');

    try {
      const result = await segmentFrame({
        video_id: videoId,
        frame_idx: frameIdx,
        positive_points: annotations.positivePoints.map(p => [p.x, p.y]),
        negative_points: annotations.negativePoints.map(p => [p.x, p.y]),
        boxes: annotations.boxes.map(b => [b.x1, b.y1, b.x2, b.y2]),
        polygon: annotations.polygons.flatMap(poly => poly.map(p => [p.x, p.y])),
      });
      setMaskUrl(`${API_BASE}${result.mask_path}`);
      setStatus('segmented');
      setHasSegmented(true);
      toast({ title: 'Segmentation Complete', description: 'Mask generated successfully.' });
    } catch (err) {
      toast({ title: 'Segmentation Failed', description: 'Could not connect to segmentation backend.', variant: 'destructive' });
      setStatus('ready');
    }
  }, [videoId, frameIdx, annotations, canSegment, toast]);

  const handleTrack = useCallback(async () => {
    setStatus('tracking');
    setTrackingProgress(0);

    try {
      // Simulate progress while waiting
      const progressInterval = setInterval(() => {
        setTrackingProgress(prev => Math.min(prev + Math.random() * 8, 90));
      }, 600);

      const result = await propagateVideoMask(videoId);
      clearInterval(progressInterval);
      setTrackingProgress(100);
      setMasksFolder(`${API_BASE}${result.masks_folder}`);
      setStatus('tracked');
      toast({ title: 'Tracking Complete', description: 'Masks propagated across all frames.' });
    } catch (err) {
      toast({ title: 'Tracking Failed', description: 'Could not connect to tracking backend.', variant: 'destructive' });
      setStatus('segmented');
    }
  }, [videoId, toast]);

  const handleClear = () => {
    setAnnotations(emptyAnnotations);
    setMaskUrl(null);
    setActiveTool('none');
    setHasSegmented(false);
    setClearSignal(prev => prev + 1);
    if (status === 'segmented') setStatus('ready');
  };

  const isUploading = status === 'uploading' || status === 'extracting';
  const showPlayer = !['idle', 'uploading', 'extracting'].includes(status);

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Top Bar */}
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
        {videoId && (
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span>Video ID: <span className="font-mono text-primary">{videoId}</span></span>
            <span className="px-2 py-0.5 rounded-full bg-primary/10 text-primary font-medium capitalize">
              {status}
            </span>
          </div>
        )}
      </header>

      {/* Main Content */}
      <main className="flex-1 flex items-center justify-center p-6">
        {(status === 'idle' || isUploading) && (
          <VideoUploader
            onUploadComplete={handleUploadComplete}
            uploadProgress={uploadProgress}
            extractionProgress={extractionProgress}
            status={status === 'idle' ? 'idle' : status as 'uploading' | 'extracting'}
          />
        )}

        {showPlayer && (
          <div className="w-full max-w-7xl flex flex-col gap-4">
            {/* Video Player */}
            <div className="w-full">
              <VideoPlayer
                videoUrl={videoUrl}
                activeTool={activeTool}
                annotations={annotations}
                onAnnotationsChange={setAnnotations}
                maskUrl={maskUrl}
                masksFolder={masksFolder}
                fps={fps}
                onFrameIdxChange={setFrameIdx}
                isPaused={isPaused}
                onPausedChange={setIsPaused}
                clearSignal={clearSignal}
              />

              {/* Tracking Progress */}
              {status === 'tracking' && (
                <div className="mt-4 p-4 rounded-lg border border-border bg-card">
                  <div className="flex justify-between text-sm mb-2">
                    <span className="text-foreground font-medium">Propagating masks...</span>
                    <span className="text-primary font-mono">{Math.round(trackingProgress)}%</span>
                  </div>
                  <Progress value={trackingProgress} className="h-2" />
                </div>
              )}
            </div>

            {/* Toolbar - below video */}
            <AnnotationToolbar
              activeTool={activeTool}
              onToolChange={setActiveTool}
              onSegment={handleSegment}
              onTrack={handleTrack}
              onClear={handleClear}
              canSegment={canSegment}
              canTrack={hasSegmented}
              isSegmenting={status === 'segmenting'}
              isTracking={status === 'tracking'}
              isPaused={isPaused}
            />
          </div>
        )}
      </main>
    </div>
  );
};

export default Workspace;
