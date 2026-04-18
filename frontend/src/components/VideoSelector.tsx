import { useEffect, useState, useCallback, useRef } from 'react';
import { Film, Upload, RefreshCw, Play, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { listVideos, deleteVideo } from '@/lib/api';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

interface VideoSelectorProps {
  onSelectExisting: (videoName: string, fps?: number) => void;
  onUploadNew: (file: File, name: string, fps?: number) => void;
  uploadProgress: number;
  isUploading: boolean;
  isSelecting: boolean;
}

const VideoSelector = ({
  onSelectExisting, onUploadNew, uploadProgress, isUploading, isSelecting,
}: VideoSelectorProps) => {
  const [videos, setVideos] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [uploadName, setUploadName] = useState('');
  const [selectedFps, setSelectedFps] = useState<string>('native');
  const [isDragging, setIsDragging] = useState(false);
  const [isDeleting, setIsDeleting] = useState<string | null>(null);
  const [videoToConfirmDelete, setVideoToConfirmDelete] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  
  const currentFps = selectedFps === 'native' ? undefined : Number(selectedFps);

  const fetchVideos = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const { videos } = await listVideos();
      setVideos(videos);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchVideos(); }, [fetchVideos]);

  const handleDelete = async (name: string) => {
    try {
      setIsDeleting(name);
      await deleteVideo(name);
      await fetchVideos();
    } catch (e) {
      console.error(e);
      alert(`Could not delete video ${name}`);
    } finally {
      setIsDeleting(null);
    }
  };

  const handleFile = useCallback((file: File) => {
    if (file.type.startsWith('video/')) {
      const name = uploadName.trim() || file.name.replace(/\.[^.]+$/, '');
      onUploadNew(file, name, currentFps);
    }
  }, [onUploadNew, uploadName, currentFps]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }, [handleFile]);

  if (isUploading) {
    return (
      <div className="flex flex-col items-center gap-6 p-12 rounded-xl border border-border bg-card max-w-lg mx-auto">
        <Upload className="h-10 w-10 text-primary animate-pulse" />
        <div className="w-full space-y-2">
          <div className="flex justify-between text-sm">
            <span className="text-foreground font-medium">Uploading & extracting frames...</span>
            <span className="text-primary font-mono">{Math.round(uploadProgress)}%</span>
          </div>
          <Progress value={uploadProgress} className="h-2" />
          <p className="text-xs text-muted-foreground text-center">
            Backend is processing frames — this may take a moment
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full max-w-2xl mx-auto flex flex-col gap-8">
      {/* FPS Settings */}
      <div className="flex flex-col gap-2 p-4 rounded-xl border border-primary/20 bg-primary/5">
        <label className="text-sm font-semibold text-primary flex items-center gap-2">
          <RefreshCw className="h-4 w-4" />
          Processing Framerate (FPS)
        </label>
        <div className="flex items-center gap-4">
          <Select value={selectedFps} onValueChange={setSelectedFps}>
            <SelectTrigger className="w-full bg-background border-primary/20">
              <SelectValue placeholder="Select FPS" />
            </SelectTrigger>
            <SelectContent className="bg-card border-border">
              <SelectItem value="native" className="text-foreground">Native Framerate (Original)</SelectItem>
              <SelectItem value="1" className="text-foreground">1 FPS (Minimal)</SelectItem>
              <SelectItem value="5" className="text-foreground">5 FPS</SelectItem>
              <SelectItem value="10" className="text-foreground">10 FPS</SelectItem>
              <SelectItem value="15" className="text-foreground">15 FPS</SelectItem>
              <SelectItem value="24" className="text-foreground">24 FPS (Film)</SelectItem>
              <SelectItem value="30" className="text-foreground">30 FPS (Standard)</SelectItem>
              <SelectItem value="60" className="text-foreground">60 FPS (High Performance)</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground max-w-[200px]">
            Lower FPS speeds up propagation but loses temporal detail.
          </p>
        </div>
      </div>

      {/* Upload Section */}
      <div className="flex flex-col gap-3">
        <Input
          placeholder="Video name (optional, defaults to filename)"
          value={uploadName}
          onChange={(e) => setUploadName(e.target.value)}
          className="flex-1"
        />
        <div
          className={`flex flex-col items-center gap-5 p-12 rounded-xl border-2 border-dashed transition-all duration-300 cursor-pointer ${
            isDragging
              ? 'border-primary bg-primary/5 shadow-[0_0_30px_hsl(var(--primary)/0.15)]'
              : 'border-border bg-card/50 hover:border-primary/50 hover:bg-card'
          }`}
          onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={handleDrop}
          onClick={() => inputRef.current?.click()}
        >
          <div className="w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center">
            <Upload className="h-7 w-7 text-primary" />
          </div>
          <div className="text-center">
            <p className="text-foreground font-semibold text-lg mb-1">Upload New Video</p>
            <p className="text-muted-foreground text-sm">Drag & drop or click to browse</p>
            <p className="text-muted-foreground/60 text-xs mt-2">Supports MP4, AVI, MOV, MKV</p>
          </div>
          <input
            ref={inputRef}
            type="file"
            accept="video/*"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleFile(file);
            }}
          />
        </div>
      </div>

      {/* Divider */}
      <div className="flex items-center gap-4">
        <div className="flex-1 h-px bg-border" />
        <span className="text-xs text-muted-foreground font-medium uppercase tracking-wider">
          or select existing
        </span>
        <div className="flex-1 h-px bg-border" />
      </div>

      {/* Existing Videos */}
      <div className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Film className="h-4 w-4 text-primary" />
            <span className="text-sm font-medium text-foreground">Server Videos</span>
          </div>
          <Button
            variant="ghost" size="sm"
            onClick={fetchVideos}
            disabled={loading}
            className="text-muted-foreground"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          </Button>
        </div>

        {loading && <p className="text-sm text-muted-foreground text-center py-6">Loading videos…</p>}
        {error && <p className="text-sm text-destructive text-center py-6">Could not connect to server.</p>}
        {!loading && !error && videos.length === 0 && (
          <p className="text-sm text-muted-foreground text-center py-6">
            No videos on the server yet. Upload one above.
          </p>
        )}
        {!loading && !error && videos.length > 0 && (
          <div className="grid gap-2 max-h-64 overflow-y-auto pr-1">
            {videos.map((name) => (
              <div
                key={name}
                className={`flex items-center justify-between gap-3 px-4 py-2.5 rounded-lg border border-border bg-background hover:border-primary/50 hover:bg-primary/5 transition-all group ${isDeleting === name ? 'opacity-50 pointer-events-none' : ''}`}
              >
                <div 
                  className="flex items-center gap-3 min-w-0 flex-1 cursor-pointer" 
                  onClick={() => !isSelecting && onSelectExisting(name, currentFps)}
                >
                  <Film className="h-4 w-4 text-muted-foreground shrink-0" />
                  <span className="text-sm text-foreground font-mono truncate">{name}</span>
                </div>
                <div className="flex items-center gap-1 shrink-0 opacity-50 group-hover:opacity-100 transition-opacity">
                  <Button
                    variant="ghost" size="icon"
                    onClick={(e) => { e.stopPropagation(); setVideoToConfirmDelete(name); }}
                    disabled={isSelecting || isDeleting === name}
                    className="h-8 w-8 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                    title="Delete video"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost" size="icon"
                    onClick={(e) => { e.stopPropagation(); onSelectExisting(name, currentFps); }}
                    disabled={isSelecting}
                    className="h-8 w-8 text-muted-foreground hover:text-primary hover:bg-primary/10"
                    title="Select video"
                  >
                    <Play className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={videoToConfirmDelete !== null} onOpenChange={(open) => !open && setVideoToConfirmDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Are you absolutely sure?</AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone. This will permanently delete the video 
              <span className="font-mono text-foreground mx-1">"{videoToConfirmDelete}"</span> 
              and all of its associated frames and generated masks.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting !== null}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                if (videoToConfirmDelete) {
                  handleDelete(videoToConfirmDelete);
                  setVideoToConfirmDelete(null);
                }
              }}
              disabled={isDeleting !== null}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeleting === videoToConfirmDelete ? 'Deleting...' : 'Delete Video'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default VideoSelector;