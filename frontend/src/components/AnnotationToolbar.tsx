import { CirclePlus, CircleMinus, Square, Pentagon, Sparkles, Layers, Trash2, Film, Eye, EyeOff } from 'lucide-react';
import { Button } from '@/components/ui/button';

type Tool = 'none' | 'positive' | 'negative' | 'box' | 'polygon';

interface AnnotationToolbarProps {
  activeTool: Tool;
  onToolChange: (tool: Tool) => void;
  onSegment: () => void;
  onTrack: () => void;
  onClear: () => void;
  onRenderMaskedVideo: () => void;
  onToggleMaskedVideo: () => void;
  canSegment: boolean;
  canTrack: boolean;
  canRenderMasked: boolean;
  isSegmenting: boolean;
  isTracking: boolean;
  isRenderingMasked: boolean;
  showingMasked: boolean;
  maskedVideoReady: boolean;
  isPaused: boolean;
}

const AnnotationToolbar = ({
  activeTool, onToolChange, onSegment, onTrack, onClear,
  onRenderMaskedVideo, onToggleMaskedVideo,
  canSegment, canTrack, canRenderMasked,
  isSegmenting, isTracking, isRenderingMasked,
  showingMasked, maskedVideoReady,
  isPaused,
}: AnnotationToolbarProps) => {
  const tools: { id: Tool; label: string; icon: typeof CirclePlus }[] = [
    { id: 'positive', label: 'Positive Point', icon: CirclePlus },
    { id: 'negative', label: 'Negative Point', icon: CircleMinus },
    { id: 'box', label: 'Bounding Box', icon: Square },
    { id: 'polygon', label: 'Polygon', icon: Pentagon },
  ];

  const handleMaskedVideoClick = () => {
    if (maskedVideoReady) {
      onToggleMaskedVideo();
    } else {
      onRenderMaskedVideo();
    }
  };

  return (
    <div className="flex items-center gap-3 p-4 rounded-xl border border-border bg-card flex-wrap">
      {/* Annotation tools */}
      <div className="flex items-center gap-2">
        {tools.map(tool => {
          const isActive = activeTool === tool.id;
          return (
            <Button
              key={tool.id}
              variant="tool"
              size="sm"
              data-active={isActive}
              disabled={!isPaused}
              onClick={() => onToolChange(isActive ? 'none' : tool.id)}
              className="gap-1.5"
            >
              <tool.icon className={`h-4 w-4 ${
                tool.id === 'positive' ? 'text-positive' :
                tool.id === 'negative' ? 'text-negative' : ''
              }`} />
              <span className="text-xs hidden sm:inline">{tool.label}</span>
            </Button>
          );
        })}
      </div>

      {!isPaused && (
        <p className="text-xs text-muted-foreground">Pause to annotate</p>
      )}

      <div className="ml-auto flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onClear} className="text-muted-foreground">
          <Trash2 className="h-4 w-4" />
          <span className="hidden sm:inline">Clear</span>
        </Button>

        <Button
          variant="segment"
          size="sm"
          disabled={!canSegment || isSegmenting}
          onClick={onSegment}
        >
          <Sparkles className="h-4 w-4" />
          {isSegmenting ? 'Segmenting...' : 'Segment'}
        </Button>

        <Button
          variant="glow"
          size="sm"
          disabled={!canTrack || isTracking}
          onClick={onTrack}
        >
          <Layers className="h-4 w-4" />
          {isTracking ? 'Tracking...' : 'Track'}
        </Button>

        {/* Show Masked Video / toggle button — only visible after tracking */}
        {canRenderMasked && (
          <Button
            variant="outline"
            size="sm"
            disabled={isRenderingMasked}
            onClick={handleMaskedVideoClick}
            className="gap-1.5 border-primary/40 text-primary hover:bg-primary/10"
          >
            {isRenderingMasked ? (
              <>
                <Film className="h-4 w-4 animate-pulse" />
                <span className="hidden sm:inline">Rendering...</span>
              </>
            ) : maskedVideoReady ? (
              showingMasked ? (
                <>
                  <EyeOff className="h-4 w-4" />
                  <span className="hidden sm:inline">Show Original</span>
                </>
              ) : (
                <>
                  <Eye className="h-4 w-4" />
                  <span className="hidden sm:inline">Show Masked</span>
                </>
              )
            ) : (
              <>
                <Film className="h-4 w-4" />
                <span className="hidden sm:inline">Show Masked Video</span>
              </>
            )}
          </Button>
        )}
      </div>
    </div>
  );
};

export default AnnotationToolbar;