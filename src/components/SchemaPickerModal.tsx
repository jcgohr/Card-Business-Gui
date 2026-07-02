import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./SchemaPickerModal.css";

interface SkuSchema {
  id: number;
  name: string;
  segment_labels: string[];
  created_at: string;
}

type CsvFormat = "carddealerpro" | "carduploader";

interface Props {
  path: string;
  filename: string;
  onConfirm: (schemaId: number | null, keepFirstSku: boolean, format: CsvFormat, chaosLocation: string | null) => void;
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
  const [format, setFormat] = useState<CsvFormat>("carduploader");
  const [chaosSegments, setChaosSegments] = useState<string[]>(["", "", ""]);

  // New schema form
  const [newName, setNewName] = useState("");
  const [newLabels, setNewLabels] = useState<string[]>([...DEFAULT_LABELS]);
  const [creating, setCreating] = useState(false);
  const [keepFirstSku, setKeepFirstSku] = useState(false);

  useEffect(() => {
    invoke<SkuSchema[]>("get_sku_schemas").then(setSchemas).catch(() => {});
    invoke<string[]>("preview_inventory_csv", { path }).then(setSamples).catch(() => {});
    invoke<string>("detect_inventory_format", { path })
      .then(f => setFormat(f as CsvFormat))
      .catch(() => {});
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
        onConfirm(schema.id, keepFirstSku, format, chaosLocation);
      } catch (e) {
        alert(`Failed to create schema: ${e}`);
        setCreating(false);
      }
    } else {
      onConfirm(selectedId, keepFirstSku, format, chaosLocation);
    }
  }

  const filledSegments = chaosSegments.map(s => s.trim()).filter(Boolean);
  const chaosLocation = (format === "carddealerpro" && filledSegments.length > 0)
    ? filledSegments.join("-")
    : null;

  const canImport = !!selectedId || !!newName.trim();
  const showBreakdown = activeLabels.length > 0 && samples.length > 0;

  return (
    <div className="spm-backdrop" onClick={onCancel}>
      <div className="spm" onClick={e => e.stopPropagation()}>

        <div className="spm-header">
          <span className="spm-title">SKU Schema</span>
          <span className="spm-filename">{filename}</span>
        </div>

        <div className="spm-format-row">
          <span className="spm-format-label">Source</span>
          <div className="spm-format-toggle">
            <button
              className={`spm-format-btn${format === "carddealerpro" ? " spm-format-btn--active" : ""}`}
              onClick={() => setFormat("carddealerpro")}
            >
              <img src="/carddealerpro.svg" alt="" className="spm-format-icon" />
              CardDealerPro
            </button>
            <button
              className={`spm-format-btn${format === "carduploader" ? " spm-format-btn--active" : ""}`}
              onClick={() => setFormat("carduploader")}
            >
              <img src="/carduploader.png" alt="" className="spm-format-icon" />
              CardUploader
            </button>
          </div>
        </div>

        <div className="spm-body">
          {/* Chaos inventory location — CDP only */}
          {format === "carddealerpro" && (
            <div className="spm-section spm-chaos-section">
              <p className="spm-section-label">Chaos inventory location</p>
              <div className="spm-chaos-segments">
                {chaosSegments.map((seg, i) => (
                  <div key={i} className="spm-chaos-seg-row">
                    <input
                      className="spm-chaos-input"
                      type="text"
                      placeholder={i === 0 ? "box1" : String(i)}
                      value={seg}
                      onChange={e => setChaosSegments(prev => prev.map((s, idx) => idx === i ? e.target.value : s))}
                    />
                    {i < chaosSegments.length - 1 && <span className="spm-chaos-sep">–</span>}
                    {chaosSegments.length > 1 && (
                      <button
                        className="spm-chaos-remove"
                        onClick={() => setChaosSegments(prev => prev.filter((_, idx) => idx !== i))}
                        title="Remove segment"
                      >✕</button>
                    )}
                  </div>
                ))}
                <button
                  className="spm-chaos-add"
                  onClick={() => setChaosSegments(prev => [...prev, ""])}
                >+ segment</button>
              </div>
              {chaosLocation && (
                <p className="spm-chaos-preview">
                  {chaosLocation}-1, {chaosLocation}-2, {chaosLocation}-3, …
                </p>
              )}
            </div>
          )}

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
          {format === "carduploader" && (
            <label className="spm-keep-sku">
              <input
                type="checkbox"
                checked={keepFirstSku}
                onChange={e => setKeepFirstSku(e.target.checked)}
              />
              Keep first SKU in CustomLabel
            </label>
          )}
          <button className="spm-skip" onClick={() => onConfirm(null, keepFirstSku, format, chaosLocation)}>
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
