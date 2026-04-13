import { CirclePlus, CircleMinus, Square, Pentagon, Sparkles, Layers, Trash2, Film, Eye, EyeOff, Undo2, Shapes } from 'lucide-react';
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
  onGetPolygons: () => void;
  canSegment: boolean;
  canTrack: boolean;
  canRenderMasked: boolean;
  canGetPolygons: boolean;
  isSegmenting: boolean;
  isTracking: boolean;
  isRenderingMasked: boolean;
  isGettingPolygons: boolean;
  showingMasked: boolean;
  maskedVideoReady: boolean;
  isPaused: boolean;
  hidePrompts: boolean;
  onToggleHidePrompts: () => void;
  annotations: Annotations;
  onAnnotationsChange: (a: Annotations) => void;
  activeObjectLabel?: string;
  activeObjectColor?: string;
}

const AnnotationToolbar = ({
  activeTool, onToolChange, onSegment, onTrack, onClear,
  onRenderMaskedVideo, onToggleMaskedVideo, onGetPolygons,
  canSegment, canTrack, canRenderMasked, canGetPolygons,
  isSegmenting, isTracking, isRenderingMasked, isGettingPolygons,
  showingMasked, maskedVideoReady, isPaused,
  hidePrompts, onToggleHidePrompts,
  annotations, onAnnotationsChange,
  activeObjectLabel = 'Object',
  activeObjectColor = '#1d9e75',
}: AnnotationToolbarProps) => {
  const tools: { id: Tool; label: string; icon: typeof CirclePlus }[] = [
    { id: 'positive', label: 'Positive Point', icon: CirclePlus },
    { id: 'negative', label: 'Negative Point', icon: CircleMinus },
    { id: 'box', label: 'Bounding Box', icon: Square },
    { id: 'polygon', label: 'Polygon', icon: Pentagon },
  ];

  const handleUndo = () => {
    if (activeTool === 'positive' && annotations.positivePoints.length > 0) {
      onAnnotationsChange({ ...annotations, positivePoints: annotations.positivePoints.slice(0, -1) });
    } else if (activeTool === 'negative' && annotations.negativePoints.length > 0) {
      onAnnotationsChange({ ...annotations, negativePoints: annotations.negativePoints.slice(0, -1) });
    } else if (activeTool === 'box' && annotations.boxes.length > 0) {
      onAnnotationsChange({ ...annotations, boxes: annotations.boxes.slice(0, -1) });
    } else if (activeTool === 'polygon' && annotations.polygons.length > 0) {
      const polys = [...annotations.polygons];
      const last = [...polys[polys.length - 1]];
      if (last.length > 1) {
        polys[polys.length - 1] = last.slice(0, -1);
      } else {
        polys.pop();
      }
      onAnnotationsChange({ ...annotations, polygons: polys, __undoPolygonPoint: true } as any);
    }
  };

  const canUndo = isPaused && (
    (activeTool === 'positive' && annotations.positivePoints.length > 0) ||
    (activeTool === 'negative' && annotations.negativePoints.length > 0) ||
    (activeTool === 'box' && annotations.boxes.length > 0) ||
    (activeTool === 'polygon')
  );

  return (
    <div className="flex items-center gap-3 p-4 rounded-xl border border-border bg-card flex-wrap">
      {/* Active object context pill */}
      <div
        className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border"
        style={{
          borderColor: activeObjectColor + '60',
          backgroundColor: activeObjectColor + '18',
          color: activeObjectColor,
        }}
      >
        <span className="w-2 h-2 rounded-full" style={{ backgroundColor: activeObjectColor }} />
        {activeObjectLabel}
      </div>

      {/* Annotation tools */}
      <div className="flex items-center gap-2">
        {tools.map(tool => {
          const isActive = activeTool === tool.id;
          return (
            <Button
              key={tool.id}
              variant="tool" size="sm"
              data-active={isActive}
              disabled={!isPaused}
              onClick={() => onToolChange(isActive ? 'none' : tool.id)}
              className="gap-1.5"
              style={isActive ? { borderColor: activeObjectColor + '80', color: activeObjectColor } : {}}
            >
              <tool.icon
                className={`h-4 w-4 ${tool.id === 'negative' ? 'text-destructive' : ''}`}
                style={isActive && tool.id !== 'negative' ? { color: activeObjectColor } : {}}
              />
              <span className="text-xs hidden sm:inline">{tool.label}</span>
            </Button>
          );
        })}
      </div>

      {/* Undo */}
      {activeTool !== 'none' && (
        <Button variant="ghost" size="sm" disabled={!canUndo} onClick={handleUndo} className="text-muted-foreground gap-1.5">
          <Undo2 className="h-4 w-4" />
          <span className="hidden sm:inline text-xs">Undo</span>
        </Button>
      )}

      {!isPaused && <p className="text-xs text-muted-foreground">Pause to annotate</p>}

      <div className="ml-auto flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onToggleHidePrompts} className="text-muted-foreground gap-1.5">
          {hidePrompts ? (
            <><Eye className="h-4 w-4" /><span className="hidden sm:inline text-xs">Show Prompts</span></>
          ) : (
            <><EyeOff className="h-4 w-4" /><span className="hidden sm:inline text-xs">Hide Prompts</span></>
          )}
        </Button>

        <Button variant="ghost" size="sm" onClick={onClear} className="text-muted-foreground">
          <Trash2 className="h-4 w-4" />
          <span className="hidden sm:inline">Clear</span>
        </Button>

        <Button variant="segment" size="sm" disabled={!canSegment || isSegmenting} onClick={onSegment}>
          <Sparkles className="h-4 w-4" />
          {isSegmenting ? 'Segmenting...' : 'Segment'}
        </Button>

        <Button
          variant="outline" size="sm" disabled={isGettingPolygons} onClick={onGetPolygons}
          className="gap-1.5 border-violet-500/40 text-violet-500 hover:bg-violet-500/10 disabled:opacity-40"
          title="Fetch saved mask and convert to editable polygon points"
        >
          <Shapes className="h-4 w-4" />
          {isGettingPolygons ? 'Fetching...' : 'Get Polygons'}
        </Button>

        <Button variant="glow" size="sm" disabled={!canTrack || isTracking} onClick={onTrack}>
          <Layers className="h-4 w-4" />
          {isTracking ? 'Tracking...' : 'Track All'}
        </Button>

        <Button
          variant="outline" size="sm"
          disabled={isRenderingMasked || !canRenderMasked}
          onClick={maskedVideoReady ? onToggleMaskedVideo : onRenderMaskedVideo}
          className="gap-1.5 border-primary/40 text-primary hover:bg-primary/10 disabled:opacity-40"
        >
          {isRenderingMasked ? (
            <><Film className="h-4 w-4 animate-pulse" /><span className="hidden sm:inline">Rendering...</span></>
          ) : maskedVideoReady ? (
            showingMasked ? (
              <><EyeOff className="h-4 w-4" /><span className="hidden sm:inline">Show Original</span></>
            ) : (
              <><Eye className="h-4 w-4" /><span className="hidden sm:inline">Show Masked</span></>
            )
          ) : (
            <><Film className="h-4 w-4" /><span className="hidden sm:inline">Show Masked Video</span></>
          )}
        </Button>
      </div>
    </div>
  );
};

export default AnnotationToolbar;