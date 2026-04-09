import { useState, useRef, useEffect } from 'react';
import { Plus, Pencil, Trash2, Check, X, CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export interface TrackedObject {
  id: number;
  label: string;
  color: { hex: string; r: number; g: number; b: number; };
}

interface ObjectManagerProps {
  objects: TrackedObject[];
  activeObjectId: number;
  segmentedObjectIds: Set<number>;
  onSelect: (id: number) => void;
  onAdd: (label: string) => void;
  onRemove: (id: number) => void;
  onRename: (id: number, label: string) => void;
}

const ObjectManager = ({
  objects, activeObjectId, segmentedObjectIds,
  onSelect, onAdd, onRemove, onRename,
}: ObjectManagerProps) => {
  const [adding, setAdding] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editLabel, setEditLabel] = useState('');
  const addInputRef = useRef<HTMLInputElement>(null);
  const editInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (adding) addInputRef.current?.focus(); }, [adding]);
  useEffect(() => { if (editingId !== null) editInputRef.current?.focus(); }, [editingId]);

  const commitAdd = () => {
    onAdd(newLabel.trim() || `Object ${objects.length + 1}`);
    setNewLabel('');
    setAdding(false);
  };

  const commitRename = () => {
    if (editingId !== null && editLabel.trim()) {
      onRename(editingId, editLabel.trim());
    }
    setEditingId(null);
  };

  return (
    <div className="flex items-center gap-2 p-3 rounded-xl border border-border bg-card flex-wrap">
      <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide shrink-0 mr-1">
        Objects
      </span>

      {objects.map(obj => {
        const isActive = obj.id === activeObjectId;
        const isSegmented = segmentedObjectIds.has(obj.id);

        return (
          <div
            key={obj.id}
            onClick={() => { if (editingId !== obj.id) onSelect(obj.id); }}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border cursor-pointer transition-all duration-150 select-none ${
              isActive
                ? 'border-primary bg-primary/10 shadow-sm'
                : 'border-border hover:border-border/80 hover:bg-muted/40'
            }`}
          >
            <span
              className="w-3 h-3 rounded-full shrink-0 ring-1 ring-black/10"
              style={{ backgroundColor: obj.color.hex }}
            />

            {editingId === obj.id ? (
              <Input
                ref={editInputRef}
                value={editLabel}
                onChange={e => setEditLabel(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
                  if (e.key === 'Escape') setEditingId(null);
                }}
                onClick={e => e.stopPropagation()}
                className="h-5 w-24 text-xs px-1 py-0 border-0 bg-transparent focus-visible:ring-1"
              />
            ) : (
              <span className={`text-xs font-medium ${isActive ? 'text-primary' : 'text-foreground'}`}>
                {obj.label}
              </span>
            )}

            {isSegmented && editingId !== obj.id && (
              <CheckCircle2 className="h-3 w-3 text-green-500 shrink-0" />
            )}

            {isActive && editingId !== obj.id && (
              <div className="flex items-center gap-0.5 ml-0.5" onClick={e => e.stopPropagation()}>
                <button
                  onClick={() => { setEditingId(obj.id); setEditLabel(obj.label); }}
                  className="text-muted-foreground hover:text-foreground p-0.5 rounded"
                  title="Rename"
                >
                  <Pencil className="h-3 w-3" />
                </button>
                {objects.length > 1 && (
                  <button
                    onClick={() => onRemove(obj.id)}
                    className="text-muted-foreground hover:text-destructive p-0.5 rounded"
                    title="Remove object"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                )}
              </div>
            )}

            {editingId === obj.id && (
              <div className="flex items-center gap-0.5 ml-0.5" onClick={e => e.stopPropagation()}>
                <button onClick={commitRename} className="text-green-500 hover:text-green-400 p-0.5 rounded">
                  <Check className="h-3 w-3" />
                </button>
                <button onClick={() => setEditingId(null)} className="text-muted-foreground hover:text-foreground p-0.5 rounded">
                  <X className="h-3 w-3" />
                </button>
              </div>
            )}
          </div>
        );
      })}

      {adding ? (
        <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-dashed border-primary/60 bg-primary/5">
          <Input
            ref={addInputRef}
            value={newLabel}
            placeholder={`Object ${objects.length + 1}`}
            onChange={e => setNewLabel(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') { e.preventDefault(); commitAdd(); }
              if (e.key === 'Escape') { setAdding(false); setNewLabel(''); }
            }}
            className="h-5 w-28 text-xs px-1 py-0 border-0 bg-transparent focus-visible:ring-1"
          />
          <button onClick={commitAdd} className="text-green-500 hover:text-green-400 p-0.5">
            <Check className="h-3 w-3" />
          </button>
          <button onClick={() => { setAdding(false); setNewLabel(''); }} className="text-muted-foreground hover:text-foreground p-0.5">
            <X className="h-3 w-3" />
          </button>
        </div>
      ) : (
        <Button
          variant="ghost" size="sm"
          onClick={() => setAdding(true)}
          className="h-7 gap-1 text-xs text-muted-foreground border border-dashed border-border hover:border-primary/50 hover:text-primary"
        >
          <Plus className="h-3.5 w-3.5" />
          Add Object
        </Button>
      )}

      {objects.length > 1 && (
        <p className="text-xs text-muted-foreground ml-auto">
          Annotating: <span className="font-medium" style={{ color: objects.find(o => o.id === activeObjectId)?.color.hex }}>
            {objects.find(o => o.id === activeObjectId)?.label}
          </span>
        </p>
      )}
    </div>
  );
};

export default ObjectManager;