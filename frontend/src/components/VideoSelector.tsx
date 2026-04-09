import { useEffect, useState, useCallback, useRef } from 'react';
import { Film, Upload, RefreshCw, Play } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { listVideos } from '@/lib/api';

interface VideoSelectorProps {
  onSelectExisting: (videoName: string) => void;
  onUploadNew: (file: File, name: string) => void;
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
  const [isDragging, setIsDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

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

  const handleFile = useCallback((file: File) => {
    if (file.type.startsWith('video/')) {
      const name = uploadName.trim() || file.name.replace(/\.[^.]+$/, '');
      onUploadNew(file, name);
    }
  }, [onUploadNew, uploadName]);

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
              <button
                key={name}
                disabled={isSelecting}
                onClick={() => onSelectExisting(name)}
                className="flex items-center justify-between gap-3 px-4 py-3 rounded-lg border border-border bg-background hover:border-primary/50 hover:bg-primary/5 transition-all text-left group disabled:opacity-50"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <Film className="h-4 w-4 text-muted-foreground shrink-0" />
                  <span className="text-sm text-foreground font-mono truncate">{name}</span>
                </div>
                <Play className="h-3.5 w-3.5 text-muted-foreground group-hover:text-primary transition-colors shrink-0" />
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default VideoSelector;