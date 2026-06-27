import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./FulfillmentManager.css";

interface FulfillmentBatch {
  id: number;
  filename: string;
  imported_at: string;
  order_count: number;
  new_order_count: number;
  item_count: number;
}

interface PickSheetItem {
  order_id: number;
  order_number: string;
  recipient: string;
  custom_label: string;
  item_title: string;
  quantity: number;
}

// ---------------------------------------------------------------------------
// SKU sort — natural numeric sort per segment so box1-1-1-4 < box1-1-1-32
// ---------------------------------------------------------------------------

function parseSkuSegment(seg: string): [string, number] {
  const m = seg.match(/^([a-zA-Z]*)(\d+)([a-zA-Z]*)$/);
  if (m) return [m[1] + m[3], parseInt(m[2], 10)];
  return [seg, 0];
}

function compareSku(a: string, b: string): number {
  const ap = a.split("-").map(parseSkuSegment);
  const bp = b.split("-").map(parseSkuSegment);
  for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
    const [aAlpha, aNum] = ap[i] ?? ["", 0];
    const [bAlpha, bNum] = bp[i] ?? ["", 0];
    if (aAlpha !== bAlpha) return aAlpha < bAlpha ? -1 : 1;
    if (aNum !== bNum) return aNum - bNum;
  }
  return 0;
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleDateString();
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function FulfillmentManager() {
  const [batches, setBatches] = useState<FulfillmentBatch[]>([]);
  const [selectedBatch, setSelectedBatch] = useState<FulfillmentBatch | null>(null);
  const [pickItems, setPickItems] = useState<PickSheetItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [statusMsg, setStatusMsg] = useState<{ text: string; kind: "ok" | "err" } | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  const loadBatches = useCallback(async () => {
    try {
      const result = await invoke<FulfillmentBatch[]>("get_fulfillments");
      setBatches(result);
    } catch (e) {
      setStatusMsg({ text: `Load error: ${e}`, kind: "err" });
    }
  }, []);

  useEffect(() => { loadBatches(); }, [loadBatches]);

  async function handleSelectBatch(batch: FulfillmentBatch) {
    setSelectedBatch(batch);
    setPickItems([]);
    try {
      const result = await invoke<PickSheetItem[]>("get_pick_sheet", { fulfillmentId: batch.id });
      setPickItems(result);
    } catch (e) {
      setStatusMsg({ text: `Pick sheet error: ${e}`, kind: "err" });
    }
  }

  async function handleImport() {
    const path = await invoke<string | null>("select_file", {
      filterName: "CSV Files",
      filterExt: "csv",
    });
    if (!path) return;
    setLoading(true);
    setStatusMsg(null);
    try {
      const result = await invoke<{ rows_imported: number; already_existed: number }>(
        "import_orders_csv", { path }
      );
      const skippedNote = result.already_existed > 0
        ? ` (${result.already_existed} already existed)`
        : "";
      setStatusMsg({ text: `Imported ${result.rows_imported} order items.${skippedNote}`, kind: "ok" });
      await loadBatches();
      // Auto-open the newly created batch (first in list after reload)
      const updated = await invoke<FulfillmentBatch[]>("get_fulfillments");
      setBatches(updated);
      if (updated.length > 0) handleSelectBatch(updated[0]);
    } catch (e) {
      setStatusMsg({ text: `Import failed: ${e}`, kind: "err" });
    } finally {
      setLoading(false);
    }
  }

  // ── Pick sheet derived data ────────────────────────────────────────────────

  const withSku    = [...pickItems.filter((i) => i.custom_label)].sort((a, b) => compareSku(a.custom_label, b.custom_label));
  const withoutSku = pickItems.filter((i) => !i.custom_label);

  const seenOrderIds: number[] = [];
  for (const item of [...withSku, ...withoutSku]) {
    if (!seenOrderIds.includes(item.order_id)) seenOrderIds.push(item.order_id);
  }
  const orderNumMap = new Map(seenOrderIds.map((id, idx) => [id, idx + 1]));

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="ff">
      <div className="ff-header">
        <div className="ff-header-left">
          {selectedBatch && (
            <button className="ff-back-btn" onClick={() => { setSelectedBatch(null); setPickItems([]); }}>
              ← Back
            </button>
          )}
          <h2 className="ff-title">
            {selectedBatch ? baseName(selectedBatch.filename) : "Fulfillment"}
          </h2>
        </div>
        <div className="ff-header-right">
          {selectedBatch && (
            <button className="ff-ps-print-btn" onClick={() => invoke("print_webview")}>
              Print
            </button>
          )}
          {!selectedBatch && (
            <>
              {batches.length > 0 && (
                confirmClear ? (
                  <>
                    <span className="ff-clear-prompt">Clear all?</span>
                    <button className="ff-clear-confirm-btn" onClick={async () => {
                      await invoke("clear_fulfillments");
                      setConfirmClear(false);
                      setBatches([]);
                      setStatusMsg({ text: "All fulfillment data cleared.", kind: "ok" });
                    }}>Yes, clear</button>
                    <button className="ff-clear-cancel-btn" onClick={() => setConfirmClear(false)}>Cancel</button>
                  </>
                ) : (
                  <button className="ff-clear-btn" onClick={() => setConfirmClear(true)}>Clear All</button>
                )
              )}
              <button className="ff-import-btn" onClick={handleImport} disabled={loading}>
                {loading ? "Importing…" : "Import Orders CSV"}
              </button>
            </>
          )}
        </div>
      </div>

      {statusMsg && (
        <div className={`ff-msg ff-msg--${statusMsg.kind}`}>{statusMsg.text}</div>
      )}

      {/* ── Batch chips ────────────────────────────────────────────────────── */}

      {!selectedBatch && (
        <div className="ff-batches">
          {batches.length === 0 ? (
            <div className="ff-empty">No fulfillments yet. Import an eBay orders CSV to get started.</div>
          ) : (
            batches.map((b) => {
              const done = b.new_order_count === 0;
              return (
                <button
                  key={b.id}
                  className={`ff-batch-chip${done ? " ff-batch-chip--done" : ""}`}
                  onClick={() => handleSelectBatch(b)}
                >
                  <span className="ff-batch-name">{baseName(b.filename)}</span>
                  <span className="ff-batch-meta">
                    {formatDate(b.imported_at)} · {b.order_count} order{b.order_count !== 1 ? "s" : ""} · {b.item_count} item{b.item_count !== 1 ? "s" : ""}
                  </span>
                  {done
                    ? <span className="ff-batch-badge ff-batch-badge--done">Complete</span>
                    : <span className="ff-batch-badge ff-batch-badge--open">{b.new_order_count} unpacked</span>
                  }
                </button>
              );
            })
          )}
        </div>
      )}

      {/* ── Pick sheet ─────────────────────────────────────────────────────── */}

      {selectedBatch && (
        <div className="ff-picksheet">
          {pickItems.length === 0 ? (
            <div className="ff-empty">All orders in this batch are packed.</div>
          ) : (
            <>
              <div className="ff-ps-print-header">
                <span className="ff-ps-print-title">Pick Sheet</span>
                <span className="ff-ps-print-meta">
                  {formatDate(selectedBatch.imported_at)} &nbsp;·&nbsp;
                  {pickItems.length} item{pickItems.length !== 1 ? "s" : ""}
                </span>
              </div>

              <div className="ff-ps-toolbar">
                <span className="ff-ps-summary">
                  {pickItems.length} item{pickItems.length !== 1 ? "s" : ""} · {seenOrderIds.length} order{seenOrderIds.length !== 1 ? "s" : ""}
                  {withoutSku.length > 0 && (
                    <span className="ff-ps-no-sku-note"> · {withoutSku.length} without a location</span>
                  )}
                </span>
              </div>

              <div className="ff-ps-table">
                <div className="ff-ps-col-headers">
                  <span>#</span>
                  <span>Location</span>
                  <span>Card</span>
                </div>

                {withSku.map((item, idx) => (
                  <div key={idx} className="ff-ps-item">
                    <span className="ff-ps-order-num">{orderNumMap.get(item.order_id)}</span>
                    <span className="ff-ps-sku">{item.custom_label}</span>
                    <span className="ff-ps-title">{item.item_title || "—"}</span>
                  </div>
                ))}

                {withoutSku.map((item, idx) => (
                  <div key={`nosku-${idx}`} className="ff-ps-item">
                    <span className="ff-ps-order-num">{orderNumMap.get(item.order_id)}</span>
                    <span className="ff-ps-sku ff-ps-sku--none">—</span>
                    <span className="ff-ps-title">{item.item_title || "—"}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
