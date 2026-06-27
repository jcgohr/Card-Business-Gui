import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./SchemaPickerModal.css";

interface SkuSchema {
  id: number;
  name: string;
  segment_labels: string[];
  created_at: string;
}

interface Props {
  path: string;
  filename: string;
  onConfirm: (schemaId: number | null, keepFirstSku: boolean) => void;
  onCancel: () => void;
}

const DEFAULT_LABELS = ["Collection", "Box", "Section", "Card"];

function breakdownSku(sku: string, labels: string[]): { label: string; value: string }[] {
  return sku.split("-").map((part, i) => ({
    label: labels[i] ?? `Seg ${i + 1}`,
    value: part,
  }));
}

export default function SchemaPickerModal({ path, filename, onConfirm, onCancel }: Props) {
  const [schemas, setSchemas] = useState<SkuSchema[]>([]);
  const [samples, setSamples] = useState<string[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);

  // New schema form
  const [newName, setNewName] = useState("");
  const [newLabels, setNewLabels] = useState<string[]>([...DEFAULT_LABELS]);
  const [creating, setCreating] = useState(false);
  const [keepFirstSku, setKeepFirstSku] = useState(false);

  useEffect(() => {
    invoke<SkuSchema[]>("get_sku_schemas").then(setSchemas).catch(() => {});
    invoke<string[]>("preview_inventory_csv", { path }).then(setSamples).catch(() => {});
  }, [path]);

  // Active labels for the live preview: prefer selected schema, then new labels
  const activeLabels: string[] = selectedId !== null
    ? (schemas.find(s => s.id === selectedId)?.segment_labels ?? [])
    : newLabels.filter(Boolean);

  function selectExisting(id: number) {
    setSelectedId(id === selectedId ? null : id);
    setNewName("");
    setNewLabels([...DEFAULT_LABELS]);
  }

  function handleNewName(v: string) {
    setNewName(v);
    if (v) setSelectedId(null);
  }

  function updateLabel(i: number, v: string) {
    setNewLabels(prev => prev.map((l, idx) => idx === i ? v : l));
    setSelectedId(null);
  }

  function addLabel() {
    setNewLabels(prev => [...prev, ""]);
    setSelectedId(null);
  }

  function removeLabel(i: number) {
    setNewLabels(prev => prev.filter((_, idx) => idx !== i));
  }

  async function handleImport() {
    if (newName.trim()) {
      setCreating(true);
      try {
        const schema = await invoke<SkuSchema>("create_sku_schema", {
          name: newName.trim(),
          segmentLabels: newLabels.filter(Boolean),
        });
        onConfirm(schema.id, keepFirstSku);
      } catch (e) {
        alert(`Failed to create schema: ${e}`);
        setCreating(false);
      }
    } else {
      onConfirm(selectedId, keepFirstSku);
    }
  }

  const canImport = !!selectedId || !!newName.trim();
  const showBreakdown = activeLabels.length > 0 && samples.length > 0;

  return (
    <div className="spm-backdrop" onClick={onCancel}>
      <div className="spm" onClick={e => e.stopPropagation()}>

        <div className="spm-header">
          <span className="spm-title">SKU Schema</span>
          <span className="spm-filename">{filename}</span>
        </div>

        <div className="spm-body">
          {/* Existing schemas */}
          {schemas.length > 0 && (
            <div className="spm-section">
              <p className="spm-section-label">Select existing</p>
              <div className="spm-schema-list">
                {schemas.map(s => (
                  <button
                    key={s.id}
                    className={`spm-schema-card${selectedId === s.id ? " spm-schema-card--selected" : ""}`}
                    onClick={() => selectExisting(s.id)}
                  >
                    <span className="spm-schema-name">{s.name}</span>
                    <span className="spm-schema-labels">{s.segment_labels.join(" › ")}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {schemas.length > 0 && (
            <div className="spm-divider"><span>or define new</span></div>
          )}

          {/* New schema form */}
          <div className="spm-section">
            {schemas.length === 0 && <p className="spm-section-label">Define schema</p>}
            <input
              className="spm-name-input"
              placeholder="Schema name (e.g. FlameBooster ETB Jan 2024)"
              value={newName}
              onChange={e => handleNewName(e.target.value)}
            />
            <p className="spm-labels-hint">
              One label per hyphen-separated SKU segment. The last label is always the card's position.
            </p>
            <div className="spm-labels">
              {newLabels.map((label, i) => (
                <div key={i} className="spm-label-row">
                  <span className="spm-label-index">{i + 1}</span>
                  <input
                    className="spm-label-input"
                    value={label}
                    placeholder={`Segment ${i + 1}`}
                    onChange={e => updateLabel(i, e.target.value)}
                  />
                  {newLabels.length > 1 && (
                    <button className="spm-label-remove" onClick={() => removeLabel(i)}>✕</button>
                  )}
                </div>
              ))}
              <button className="spm-add-label" onClick={addLabel}>+ Add segment</button>
            </div>
          </div>

          {/* Live SKU breakdown from actual file samples */}
          {samples.length > 0 && (
            <div className="spm-section spm-section--examples">
              <p className="spm-section-label">SKUs from this file</p>
              <div className="spm-examples">
                {samples.map(sku => {
                  const parts = breakdownSku(sku, activeLabels);
                  return (
                    <div key={sku} className="spm-example">
                      <span className="spm-example-sku">{sku}</span>
                      {showBreakdown && (
                        <div className="spm-example-breakdown">
                          {parts.map((p, i) => (
                            <span key={i} className="spm-example-part">
                              <span className="spm-example-seg-label">{p.label}</span>
                              <span className="spm-example-seg-value">{p.value}</span>
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="spm-footer">
          <label className="spm-keep-sku">
            <input
              type="checkbox"
              checked={keepFirstSku}
              onChange={e => setKeepFirstSku(e.target.checked)}
            />
            Keep first SKU in CustomLabel
          </label>
          <button className="spm-skip" onClick={() => onConfirm(null, keepFirstSku)}>
            Import without schema
          </button>
          <div className="spm-footer-right">
            <button className="spm-cancel" onClick={onCancel}>Cancel</button>
            <button
              className="spm-confirm"
              disabled={!canImport || creating}
              onClick={handleImport}
            >
              {creating ? "Creating…" : "Import →"}
            </button>
          </div>
        </div>

      </div>
    </div>
  );
}
