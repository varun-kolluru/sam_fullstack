import { useCallback, useRef, useState } from 'react';
import { Upload, Film, CheckCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';

interface VideoUploaderProps {
  onUploadComplete: (file: File, videoUrl: string) => void;
  uploadProgress: number;
  extractionProgress: number;
  status: 'idle' | 'uploading' | 'extracting';
}

const VideoUploader = ({ onUploadComplete, uploadProgress, extractionProgress, status }: VideoUploaderProps) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  const handleFile = useCallback((file: File) => {
    if (!file.type.startsWith('video/')) return;
    const url = URL.createObjectURL(file);
    onUploadComplete(file, url);
  }, [onUploadComplete]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }, [handleFile]);

  if (status === 'uploading') {
    return (
      <div className="flex flex-col items-center gap-6 p-12 rounded-xl border border-border bg-card max-w-lg mx-auto">
        <Upload className="h-10 w-10 text-primary animate-pulse" />
        <div className="w-full space-y-2">
          <div className="flex justify-between text-sm">
            <span className="text-foreground font-medium">Uploading video...</span>
            <span className="text-primary font-mono">{Math.round(uploadProgress)}%</span>
          </div>
          <Progress value={uploadProgress} className="h-2" />
        </div>
      </div>
    );
  }

  if (status === 'extracting') {
    return (
      <div className="flex flex-col items-center gap-6 p-12 rounded-xl border border-border bg-card max-w-lg mx-auto">
        <Film className="h-10 w-10 text-primary animate-pulse" />
        <div className="w-full space-y-2">
          <div className="flex justify-between text-sm">
            <span className="text-foreground font-medium">Extracting frames...</span>
            <span className="text-primary font-mono">{Math.round(extractionProgress)}%</span>
          </div>
          <Progress value={extractionProgress} className="h-2" />
        </div>
      </div>
    );
  }

  return (
    <div
      className={`flex flex-col items-center gap-6 p-16 rounded-xl border-2 border-dashed transition-all duration-300 max-w-lg mx-auto cursor-pointer ${
        isDragging
          ? 'border-primary bg-primary/5 shadow-[0_0_30px_hsl(185_70%_42%/0.15)]'
          : 'border-border bg-card/50 hover:border-primary/50 hover:bg-card'
      }`}
      onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={handleDrop}
      onClick={() => inputRef.current?.click()}
    >
      <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center">
        <Upload className="h-8 w-8 text-primary" />
      </div>
      <div className="text-center">
        <p className="text-foreground font-semibold text-lg mb-1">Upload Medical Video</p>
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
  );
};

export default VideoUploader;
