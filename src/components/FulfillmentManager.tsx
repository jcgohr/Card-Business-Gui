import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./FulfillmentManager.css";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FulfillmentBatch {
  id: number;
  filename: string;
  imported_at: string;
  order_count: number;
  new_order_count: number;
  item_count: number;
  pick_seconds: number | null;
  pack_seconds: number | null;
  total_sales: number;
}

interface PickSheetItem {
  order_id: number;
  order_number: string;
  recipient: string;
  custom_label: string;
  item_title: string;
  quantity: number;
}

interface PackItem {
  custom_label: string;
  item_title: string;
  pic_urls: string;
  quantity: number;
}

interface PackOrder {
  order_ids: number[];
  recipient: string;
  items: PackItem[];
}

type Phase = "picksheet" | "picking" | "packing" | "complete";

// ---------------------------------------------------------------------------
// Helpers
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

function formatTime(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function parsePicUrls(raw: string): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter(Boolean);
  } catch {}
  return raw.split(/[,;|]/).map(s => s.trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function FulfillmentManager({ isActive = true }: { isActive?: boolean }) {
  const [batches, setBatches] = useState<FulfillmentBatch[]>([]);
  const [selectedBatch, setSelectedBatch] = useState<FulfillmentBatch | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [loading, setLoading] = useState(false);
  const [statusMsg, setStatusMsg] = useState<{ text: string; kind: "ok" | "err" } | null>(null);

  // Phase flow
  const [phase, setPhase] = useState<Phase>("picksheet");
  const [pickItems, setPickItems] = useState<PickSheetItem[]>([]);

  // Timers
  const [tick, setTick] = useState(0);
  const [pickStartMs, setPickStartMs] = useState(0);
  const [savedPickSecs, setSavedPickSecs] = useState(0);
  const [packStartMs, setPackStartMs] = useState(0);
  const [savedPackSecs, setSavedPackSecs] = useState(0);

  // Pack phase
  const [packOrders, setPackOrders] = useState<PackOrder[]>([]);
  const [currentOrderIdx, setCurrentOrderIdx] = useState(0);
  const [packViewMode, setPackViewMode] = useState<"detail" | "grid">("detail");
  const [checkedGridItems, setCheckedGridItems] = useState<Set<string>>(new Set());
  const [pulsePhase, setPulsePhase] = useState(false);

  // Tick every second during pick/pack
  useEffect(() => {
    if (phase !== "picking" && phase !== "packing") return;
    const id = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(id);
  }, [phase]);

  const pickElapsed = phase === "picking"
    ? Math.floor((Date.now() - pickStartMs) / 1000)
    : savedPickSecs;

  const packElapsed = phase === "packing"
    ? Math.floor((Date.now() - packStartMs) / 1000)
    : savedPackSecs;

  // Suppress unused warning — tick drives re-renders
  void tick;

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
    setPhase("picksheet");
    setPickItems([]);
    setPackOrders([]);
    setCurrentOrderIdx(0);
    setSavedPickSecs(0);
    setSavedPackSecs(0);
    try {
      const result = await invoke<PickSheetItem[]>("get_pick_sheet", { fulfillmentId: batch.id });
      setPickItems(result);
    } catch (e) {
      setStatusMsg({ text: `Pick sheet error: ${e}`, kind: "err" });
    }
  }

  async function handleImport() {
    const path = await invoke<string | null>("select_file", { filterName: "CSV Files", filterExt: "csv" });
    if (!path) return;
    setLoading(true);
    setStatusMsg(null);
    try {
      const result = await invoke<{ rows_imported: number; already_existed: number }>(
        "import_orders_csv", { path }
      );
      const note = result.already_existed > 0 ? ` (${result.already_existed} already existed)` : "";
      setStatusMsg({ text: `Imported ${result.rows_imported} order items.${note}`, kind: "ok" });
      const updated = await invoke<FulfillmentBatch[]>("get_fulfillments");
      setBatches(updated);
      if (updated.length > 0) handleSelectBatch(updated[0]);
    } catch (e) {
      setStatusMsg({ text: `Import failed: ${e}`, kind: "err" });
    } finally {
      setLoading(false);
    }
  }

  function beginPick() {
    setPickStartMs(Date.now());
    setPhase("picking");
  }

  async function donePicking() {
    setSavedPickSecs(Math.floor((Date.now() - pickStartMs) / 1000));
    try {
      const orders = await invoke<PackOrder[]>("get_pack_orders", { fulfillmentId: selectedBatch!.id });
      setPackOrders(orders);
      setCurrentOrderIdx(0);
      setPackStartMs(Date.now());
      setPhase("packing");
    } catch (e) {
      setStatusMsg({ text: `Error loading orders: ${e}`, kind: "err" });
    }
  }

  const advance = useCallback(async () => {
    const order = packOrders[currentOrderIdx];
    if (!order) return;
    try { await invoke("mark_order_packed", { orderIds: order.order_ids }); } catch {}

    if (currentOrderIdx >= packOrders.length - 1) {
      const finalPackSecs = Math.floor((Date.now() - packStartMs) / 1000);
      setSavedPackSecs(finalPackSecs);
      try {
        await invoke("save_fulfillment_times", {
          fulfillmentId: selectedBatch!.id,
          pickSeconds: savedPickSecs,
          packSeconds: finalPackSecs,
        });
      } catch {}
      setPhase("complete");
      await loadBatches();
      setTimeout(() => {
        setSelectedBatch(null);
        setPickItems([]);
        setPackOrders([]);
        setPhase("picksheet");
      }, 3000);
    } else {
      setCurrentOrderIdx(i => i + 1);
    }
  }, [packOrders, currentOrderIdx, packStartMs, loadBatches]);

  // Reset checked items when moving to a new order
  useEffect(() => { setCheckedGridItems(new Set()); }, [currentOrderIdx]);

  // Shared pulse clock — all checked grid items read from this, so they stay in sync
  useEffect(() => {
    if (phase !== "packing") return;
    const id = setInterval(() => setPulsePhase(p => !p), 700);
    return () => clearInterval(id);
  }, [phase]);

  // Keep ref fresh so keydown handler doesn't go stale
  const advanceRef = useRef(advance);
  useEffect(() => { advanceRef.current = advance; }, [advance]);

  useEffect(() => {
    if (phase !== "packing" || !isActive) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight" || e.key === "Enter") {
        e.preventDefault();
        advanceRef.current();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        setCurrentOrderIdx(i => Math.max(0, i - 1));
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [phase, isActive]);

  // ── Pick sheet derived data ──────────────────────────────────────────────

  const withSku    = [...pickItems.filter(i => i.custom_label)].sort((a, b) => compareSku(a.custom_label, b.custom_label));
  const withoutSku = pickItems.filter(i => !i.custom_label);
  const seenOrderIds: number[] = [];
  for (const item of [...withSku, ...withoutSku]) {
    if (!seenOrderIds.includes(item.order_id)) seenOrderIds.push(item.order_id);
  }
  const orderNumMap = new Map(seenOrderIds.map((id, idx) => [id, idx + 1]));

  function printPickSheet() {
    const allItems = [...withSku, ...withoutSku];
    const rows = allItems.map((item, idx) => {
      const num = orderNumMap.get(item.order_id) ?? "";
      const loc = item.custom_label || "—";
      const title = item.item_title || "—";
      const bg = idx % 2 === 1 ? "#f8f8f8" : "#ffffff";
      return `<tr style="background:${bg}">
        <td style="padding:4px 8px;border:1px solid #ccc;font-weight:700;color:#333">${num}</td>
        <td style="padding:4px 8px;border:1px solid #ccc;font-family:monospace">${loc}</td>
        <td style="padding:4px 8px;border:1px solid #ccc">${title}</td>
      </tr>`;
    }).join("");

    const date = selectedBatch ? new Date(selectedBatch.imported_at).toLocaleDateString() : "";
    const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Pick Sheet</title>
<style>
  body { font-family: sans-serif; font-size: 12px; margin: 1cm; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .meta { font-size: 10px; color: #555; margin-bottom: 14px; }
  table { width: 100%; border-collapse: collapse; }
  th { background: #f0f0f0; padding: 5px 8px; border: 1px solid #999; font-size: 10px; text-transform: uppercase; letter-spacing: .05em; text-align: left; }
  tr { page-break-inside: avoid; }
</style>
</head><body>
<h1>Pick Sheet</h1>
<p class="meta">${date} &nbsp;·&nbsp; ${allItems.length} item${allItems.length !== 1 ? "s" : ""} &nbsp;·&nbsp; ${seenOrderIds.length} order${seenOrderIds.length !== 1 ? "s" : ""}</p>
<table>
  <thead><tr>
    <th style="width:3rem">#</th>
    <th style="width:10rem">Location</th>
    <th>Card</th>
  </tr></thead>
  <tbody>${rows}</tbody>
</table>
<script>window.onload = () => window.print();<\/script>
</body></html>`;

    invoke("open_print_html", { html }).catch(e => alert(`Print error: ${e}`));
  }

  const currentPackOrder = packOrders[currentOrderIdx] ?? null;

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="ff">

      {/* ── Header ─────────────────────────────────────────────────────── */}

      <div className="ff-header">
        <div className="ff-header-left">
          {selectedBatch && phase !== "complete" && (
            <button className="ff-back-btn" onClick={() => {
              setSelectedBatch(null);
              setPickItems([]);
              setPackOrders([]);
              setPhase("picksheet");
            }}>← Back</button>
          )}
          <h2 className="ff-title">
            {!selectedBatch && "Fulfillment"}
            {selectedBatch && phase === "picksheet" && baseName(selectedBatch.filename)}
            {selectedBatch && phase === "picking"   && "Picking"}
            {selectedBatch && phase === "packing"   && `Order ${currentOrderIdx + 1} of ${packOrders.length}`}
            {phase === "complete" && "Complete"}
          </h2>
        </div>
        <div className="ff-header-right">
          {selectedBatch && phase === "picksheet" && (
            <>
              <button className="ff-ps-print-btn" onClick={printPickSheet}>Print</button>
              <button className="ff-begin-pick-btn" onClick={beginPick}>Begin Pick →</button>
            </>
          )}
          {phase === "picking" && (
            <button className="ff-done-pick-btn" onClick={donePicking}>Done Picking →</button>
          )}
          {phase === "packing" && (
            <>
              <button
                className={`ff-pack-view-btn${packViewMode === "grid" ? " ff-pack-view-btn--active" : ""}`}
                onClick={() => setPackViewMode(m => m === "detail" ? "grid" : "detail")}
              >
                {packViewMode === "detail" ? "⊞ Grid" : "☰ Detail"}
              </button>
              <span className="ff-pack-timer">
                Pick {formatTime(pickElapsed)} · Pack {formatTime(packElapsed)}
              </span>
            </>
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

      {/* ── Batch chips ────────────────────────────────────────────────── */}

      {!selectedBatch && (
        <div className="ff-batches">
          {batches.length === 0 ? (
            <div className="ff-empty">No fulfillments yet. Import an eBay orders CSV to get started.</div>
          ) : batches.map(b => {
            const done = b.new_order_count === 0;
            const totalSecs = (b.pick_seconds ?? 0) + (b.pack_seconds ?? 0);
            return (
              <button key={b.id} className={`ff-batch-chip${done ? " ff-batch-chip--done" : ""}`} onClick={() => handleSelectBatch(b)}>
                <div className="ff-batch-chip-left">
                  <span className="ff-batch-name">{baseName(b.filename)}</span>
                  <span className="ff-batch-meta">
                    {formatDate(b.imported_at)} · {b.order_count} order{b.order_count !== 1 ? "s" : ""} · {b.item_count} item{b.item_count !== 1 ? "s" : ""}
                  </span>
                  {b.pick_seconds != null && (
                    <div className="ff-batch-times">
                      <span>🕐 <span className="ff-batch-time-label">Pick</span><span className="ff-batch-time-val">{formatTime(b.pick_seconds)}</span></span>
                      <span><span className="ff-batch-time-label">Pack</span><span className="ff-batch-time-val">{formatTime(b.pack_seconds ?? 0)}</span></span>
                      <span><span className="ff-batch-time-label">Total</span><span className="ff-batch-time-val">{formatTime(totalSecs)}</span></span>
                    </div>
                  )}
                </div>
                <div className="ff-batch-chip-right">
                  {b.total_sales > 0 && (
                    <span className="ff-batch-sales">${b.total_sales.toFixed(2)}</span>
                  )}
                  {done
                    ? <span className="ff-batch-badge ff-batch-badge--done">Complete</span>
                    : <span className="ff-batch-badge ff-batch-badge--open">{b.new_order_count} unpacked</span>}
                </div>
              </button>
            );
          })}
        </div>
      )}

      {/* ── Pick sheet ─────────────────────────────────────────────────── */}

      {selectedBatch && phase === "picksheet" && (
        <div className="ff-picksheet">
          {pickItems.length === 0 ? (
            <div className="ff-empty">All orders in this batch are packed.</div>
          ) : (
            <>
              <div className="ff-ps-print-header">
                <span className="ff-ps-print-title">Pick Sheet</span>
                <span className="ff-ps-print-meta">
                  {formatDate(selectedBatch.imported_at)} &nbsp;·&nbsp; {pickItems.length} item{pickItems.length !== 1 ? "s" : ""}
                </span>
              </div>
              <div className="ff-ps-toolbar">
                <span className="ff-ps-summary">
                  {pickItems.length} item{pickItems.length !== 1 ? "s" : ""} · {seenOrderIds.length} order{seenOrderIds.length !== 1 ? "s" : ""}
                  {withoutSku.length > 0 && <span className="ff-ps-no-sku-note"> · {withoutSku.length} without a location</span>}
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

      {/* ── Picking timer ──────────────────────────────────────────────── */}

      {phase === "picking" && (
        <div className="ff-picking">
          <p className="ff-picking-label">Go pick your cards</p>
          <div className="ff-pick-timer">{formatTime(pickElapsed)}</div>
          <p className="ff-picking-hint">Press "Done Picking" when you're back at your desk</p>
        </div>
      )}

      {/* ── Packing ────────────────────────────────────────────────────── */}

      {phase === "packing" && currentPackOrder && (
        <div className="ff-packing">
          <div className="ff-pack-top">
            <div className="ff-pack-recipient">
              {currentPackOrder.recipient}
              {currentPackOrder.order_ids.length > 1 && (
                <span className="ff-pack-merged-badge">
                  {currentPackOrder.order_ids.length} orders merged
                </span>
              )}
            </div>
            <div className={`ff-pack-selection-bar${checkedGridItems.size > 0 ? " ff-pack-selection-bar--visible" : ""}`}>
              <span className="ff-pack-selection-count">
                {checkedGridItems.size} card{checkedGridItems.size !== 1 ? "s" : ""} selected
              </span>
              <button className="ff-pack-selection-clear" onClick={() => setCheckedGridItems(new Set())}>
                Clear
              </button>
            </div>
          </div>
          {packViewMode === "detail" ? (
            <div className="ff-pack-cards">
              {currentPackOrder.items.flatMap((item, idx) =>
                Array.from({ length: Math.max(1, item.quantity) }, (_, copy) => {
                  const pics = parsePicUrls(item.pic_urls);
                  return (
                    <div key={`${idx}-${copy}`} className="ff-pack-card">
                      <div className="ff-pack-card-img-wrap">
                        {pics.length > 0 ? (
                          pics.slice(0, 2).map((url, i) => (
                            <img key={i} src={url} alt={i === 0 ? "Front" : "Back"} className="ff-pack-card-img" />
                          ))
                        ) : (
                          <div className="ff-pack-card-img-placeholder">No image</div>
                        )}
                      </div>
                      <div className="ff-pack-card-info">
                        <span className="ff-pack-card-title">{item.item_title || "—"}</span>
                        {item.custom_label && <span className="ff-pack-card-sku">{item.custom_label}</span>}
                        {item.quantity > 1 && <span className="ff-pack-card-qty">×{item.quantity} — copy {copy + 1}</span>}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          ) : (
            <div className={`ff-pack-grid${pulsePhase ? " ff-pulse-bright" : " ff-pulse-dim"}`}>
              {currentPackOrder.items.flatMap((item, idx) =>
                Array.from({ length: Math.max(1, item.quantity) }, (_, copy) => {
                  const pics = parsePicUrls(item.pic_urls);
                  const key = `${idx}-${copy}`;
                  const checked = checkedGridItems.has(key);
                  return (
                    <div
                      key={key}
                      className={`ff-pack-grid-item${checked ? " ff-pack-grid-item--checked" : ""}`}
                      onClick={() => setCheckedGridItems(prev => {
                        const next = new Set(prev);
                        if (next.has(key)) next.delete(key); else next.add(key);
                        return next;
                      })}
                    >
                      {pics.length > 0
                        ? <img src={pics[0]} alt="Front" className="ff-pack-grid-img" />
                        : <div className="ff-pack-grid-img-placeholder">No image</div>
                      }
                      <span className="ff-pack-grid-title">{item.item_title || "—"}</span>
                      {item.quantity > 1 && <span className="ff-pack-grid-qty">×{item.quantity} ({copy + 1})</span>}
                    </div>
                  );
                })
              )}
            </div>
          )}
          <div className="ff-pack-footer">
            {currentOrderIdx > 0 && (
              <button className="ff-pack-back-btn" onClick={() => setCurrentOrderIdx(i => i - 1)}>
                ← Prev
              </button>
            )}
            <button className="ff-pack-next-btn" onClick={() => advanceRef.current()}>
              {currentOrderIdx < packOrders.length - 1 ? "Next Order →" : "Done Packing ✓"}
            </button>
            <span className="ff-pack-hint">← → to navigate</span>
          </div>
        </div>
      )}

      {/* ── Complete ───────────────────────────────────────────────────── */}

      {phase === "complete" && (
        <div className="ff-complete">
          <div className="ff-complete-check">✓</div>
          <div className="ff-complete-title">All Packed</div>
          <div className="ff-complete-times">
            <span>Pick time: {formatTime(savedPickSecs)}</span>
            <span>Pack time: {formatTime(savedPackSecs)}</span>
          </div>
          <p className="ff-complete-hint">Returning to fulfillments…</p>
        </div>
      )}

    </div>
  );
}
