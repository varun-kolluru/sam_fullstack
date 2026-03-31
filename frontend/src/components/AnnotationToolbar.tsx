import { CirclePlus, CircleMinus, Square, Pentagon, Sparkles, Layers, Trash2, Film, Eye, EyeOff, EyeOff as HideIcon, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { Annotations } from '@/components/VideoPlayer';

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
  hidePrompts: boolean;
  onToggleHidePrompts: () => void;
  annotations: Annotations;
  onAnnotationsChange: (a: Annotations) => void;
}

const AnnotationToolbar = ({
  activeTool, onToolChange, onSegment, onTrack, onClear,
  onRenderMaskedVideo, onToggleMaskedVideo,
  canSegment, canTrack, canRenderMasked,
  isSegmenting, isTracking, isRenderingMasked,
  showingMasked, maskedVideoReady,
  isPaused,
  hidePrompts, onToggleHidePrompts,
  annotations, onAnnotationsChange,
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

  // Undo the last annotation for the active tool
  const handleUndo = () => {
    if (activeTool === 'positive' && annotations.positivePoints.length > 0) {
      onAnnotationsChange({
        ...annotations,
        positivePoints: annotations.positivePoints.slice(0, -1),
      });
    } else if (activeTool === 'negative' && annotations.negativePoints.length > 0) {
      onAnnotationsChange({
        ...annotations,
        negativePoints: annotations.negativePoints.slice(0, -1),
      });
    } else if (activeTool === 'box' && annotations.boxes.length > 0) {
      onAnnotationsChange({
        ...annotations,
        boxes: annotations.boxes.slice(0, -1),
      });
    }
    // For polygon, undo is handled inside VideoPlayer (in-progress polygon points)
    // We emit a special signal via onAnnotationsChange with a __undoPolygonPoint flag
    else if (activeTool === 'polygon') {
      onAnnotationsChange({
        ...annotations,
        // Completed polygons: remove last point from last polygon if it exists
        polygons: annotations.polygons.length > 0
          ? (() => {
              const polys = [...annotations.polygons];
              const last = [...polys[polys.length - 1]];
              if (last.length > 1) {
                polys[polys.length - 1] = last.slice(0, -1);
              } else {
                polys.pop();
              }
              return polys;
            })()
          : annotations.polygons,
        // Signal to VideoPlayer to pop the in-progress polygon point
        __undoPolygonPoint: true,
      } as any);
    }
  };

  // Determine if undo is available for the current tool
  const canUndo = (() => {
    if (!isPaused) return false;
    if (activeTool === 'positive') return annotations.positivePoints.length > 0;
    if (activeTool === 'negative') return annotations.negativePoints.length > 0;
    if (activeTool === 'box') return annotations.boxes.length > 0;
    if (activeTool === 'polygon') return true; // VideoPlayer handles in-progress polygon
    return false;
  })();

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

      {/* Undo button — visible when a tool is active */}
      {activeTool !== 'none' && (
        <Button
          variant="ghost"
          size="sm"
          disabled={!canUndo}
          onClick={handleUndo}
          className="text-muted-foreground gap-1.5"
          title="Undo last annotation"
        >
          <Undo2 className="h-4 w-4" />
          <span className="hidden sm:inline text-xs">Undo</span>
        </Button>
      )}

      {!isPaused && (
        <p className="text-xs text-muted-foreground">Pause to annotate</p>
      )}

      <div className="ml-auto flex items-center gap-2">
        {/* Hide / Show Prompts toggle */}
        <Button
          variant="ghost"
          size="sm"
          onClick={onToggleHidePrompts}
          className="text-muted-foreground gap-1.5"
          title={hidePrompts ? 'Show prompts' : 'Hide prompts'}
        >
          {hidePrompts ? (
            <>
              <Eye className="h-4 w-4" />
              <span className="hidden sm:inline text-xs">Show Prompts</span>
            </>
          ) : (
            <>
              <EyeOff className="h-4 w-4" />
              <span className="hidden sm:inline text-xs">Hide Prompts</span>
            </>
          )}
        </Button>

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

        {/* Show Masked Video / toggle button — always visible, disabled until tracking is done */}
        <Button
          variant="outline"
          size="sm"
          disabled={isRenderingMasked || !canRenderMasked}
          onClick={handleMaskedVideoClick}
          className="gap-1.5 border-primary/40 text-primary hover:bg-primary/10 disabled:opacity-40"
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
      </div>
    </div>
  );
};

export default AnnotationToolbar;