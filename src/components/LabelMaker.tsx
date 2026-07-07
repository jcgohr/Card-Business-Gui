import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./LabelMaker.css";

interface ReturnAddress {
  return_name: string;
  return_address1: string;
  return_address2: string;
  return_city: string;
  return_state: string;
  return_zip: string;
  return_country: string;
}

interface Batch {
  id: number;
  filename: string;
  imported_at: string;
  order_count: number;
}

interface LabelOrder {
  order_id: number;
  ebay_order_number: string;
  recipient: string;
  address1: string;
  address2: string;
  city: string;
  state: string;
  zip: string;
  country: string;
}

function baseName(path: string) {
  return path.split(/[\\/]/).pop() ?? path;
}

function formatDate(s: string) {
  const d = new Date(s);
  return isNaN(d.getTime()) ? s : d.toLocaleDateString();
}

function buildLabelHtml(orders: LabelOrder[], ret: ReturnAddress): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const retLine1 = esc(ret.return_name);
  const retLine2 = esc(ret.return_address1);
  const retLine3 = ret.return_address2 ? esc(ret.return_address2) : "";
  const retLine4 = [ret.return_city, ret.return_state, ret.return_zip].filter(Boolean).map(esc).join(", ");
  const retLine5 = ret.return_country ? esc(ret.return_country) : "";

  const pages = orders.map((o, idx) => {
    const destLine2 = o.address2 ? `<div>${esc(o.address2)}</div>` : "";
    const destLine3 = [o.city, o.state, o.zip].filter(Boolean).map(esc).join(", ");
    const destLine4 = o.country ? `<div>${esc(o.country)}</div>` : "";
    const pageBreak = idx < orders.length - 1 ? ' style="break-after:page"' : "";
    return `
      <div class="label"${pageBreak}>
        <div class="return-addr">
          <div>${retLine1}</div>
          <div>${retLine2}</div>
          ${retLine3 ? `<div>${retLine3}</div>` : ""}
          <div>${retLine4}</div>
          ${retLine5 ? `<div>${retLine5}</div>` : ""}
        </div>
        <div class="dest-addr">
          <div class="dest-name">${esc(o.recipient)}</div>
          <div>${esc(o.address1)}</div>
          ${destLine2}
          <div>${destLine3}</div>
          ${destLine4}
        </div>
        <div class="order-num">#${esc(o.ebay_order_number)}</div>
      </div>`;
  }).join("\n");

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Shipping Labels</title>
<style>
  @page { size: 6in 4in landscape; margin: 0; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Arial, sans-serif; background: #fff; color: #000; }
  .label {
    width: 6in; height: 4in;
    padding: 0.3in;
    position: relative;
    overflow: hidden;
  }
  .return-addr {
    font-size: 8pt;
    line-height: 1.5;
    color: #333;
  }
  .dest-addr {
    position: absolute;
    top: 50%;
    left: 2in;
    right: 0.3in;
    transform: translateY(-50%);
    font-size: 13pt;
    line-height: 1.6;
  }
  .dest-name {
    font-size: 15pt;
    font-weight: bold;
    margin-bottom: 0.06in;
  }
  .order-num {
    position: absolute;
    bottom: 0.2in;
    right: 0.3in;
    font-size: 7pt;
    color: #aaa;
  }
</style>
</head><body>
${pages}
<script>window.onload = () => window.print();<\/script>
</body></html>`;
}

const EMPTY_DEST: LabelOrder = {
  order_id: -1, ebay_order_number: "",
  recipient: "", address1: "", address2: "",
  city: "", state: "", zip: "", country: "",
};

export default function LabelMaker() {
  const [mode, setMode] = useState<"fulfillment" | "manual">("fulfillment");
  const [returnAddr, setReturnAddr] = useState<ReturnAddress>({
    return_name: "", return_address1: "", return_address2: "",
    return_city: "", return_state: "", return_zip: "", return_country: "",
  });
  const [batches, setBatches] = useState<Batch[]>([]);
  const [selectedBatch, setSelectedBatch] = useState<Batch | null>(null);
  const [orders, setOrders] = useState<LabelOrder[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [manualDest, setManualDest] = useState<LabelOrder>({ ...EMPTY_DEST });

  useEffect(() => {
    invoke<any>("load_config").then((cfg) => {
      setReturnAddr({
        return_name:     cfg.return_name     ?? "",
        return_address1: cfg.return_address1 ?? "",
        return_address2: cfg.return_address2 ?? "",
        return_city:     cfg.return_city     ?? "",
        return_state:    cfg.return_state    ?? "",
        return_zip:      cfg.return_zip      ?? "",
        return_country:  cfg.return_country  ?? "",
      });
    }).catch(() => {});
    invoke<Batch[]>("get_fulfillments").then(setBatches).catch(() => {});
  }, []);

  async function saveReturnAddr() {
    setSaving(true);
    try {
      const cfg = await invoke<any>("load_config");
      await invoke("save_config", { config: { ...cfg, ...returnAddr } });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch {}
    setSaving(false);
  }

  async function selectBatch(batch: Batch) {
    setSelectedBatch(batch);
    setSelectedIds(new Set());
    try {
      const result = await invoke<LabelOrder[]>("get_orders_for_labels", { fulfillmentId: batch.id });
      setOrders(result);
      setSelectedIds(new Set(result.map(o => o.order_id)));
    } catch {}
  }

  function toggleOrder(id: number) {
    setSelectedIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function toggleAll() {
    if (selectedIds.size === orders.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(orders.map(o => o.order_id)));
    }
  }

  function printLabels() {
    const toPrint = orders.filter(o => selectedIds.has(o.order_id));
    if (toPrint.length === 0) return;
    const html = buildLabelHtml(toPrint, returnAddr);
    invoke("open_print_html", { html }).catch(e => alert(`Print error: ${e}`));
  }

  function printManual() {
    const html = buildLabelHtml([manualDest], returnAddr);
    invoke("open_print_html", { html }).catch(e => alert(`Print error: ${e}`));
  }

  const hasReturn = returnAddr.return_name && returnAddr.return_address1 && returnAddr.return_city;
  const manualReady = hasReturn && manualDest.recipient && manualDest.address1 && manualDest.city;

  return (
    <div className="lm">
      <div className="lm-header">
        <h2 className="lm-title">Label Maker</h2>
        <div className="lm-mode-toggle">
          <button
            className={`lm-mode-btn${mode === "fulfillment" ? " lm-mode-btn--active" : ""}`}
            onClick={() => setMode("fulfillment")}
          >From Fulfillment</button>
          <button
            className={`lm-mode-btn${mode === "manual" ? " lm-mode-btn--active" : ""}`}
            onClick={() => setMode("manual")}
          >Manual Entry</button>
        </div>
      </div>

      {/* Return address */}
      <div className="lm-section">
        <p className="lm-section-label">Return address</p>
        <div className="lm-return-grid">
          <input className="lm-input lm-input--full" placeholder="Name / Business"
            value={returnAddr.return_name}
            onChange={e => setReturnAddr(p => ({ ...p, return_name: e.target.value }))} />
          <input className="lm-input lm-input--full" placeholder="Address line 1"
            value={returnAddr.return_address1}
            onChange={e => setReturnAddr(p => ({ ...p, return_address1: e.target.value }))} />
          <input className="lm-input lm-input--full" placeholder="Address line 2 (optional)"
            value={returnAddr.return_address2}
            onChange={e => setReturnAddr(p => ({ ...p, return_address2: e.target.value }))} />
          <div className="lm-row">
            <input className="lm-input" placeholder="City"
              value={returnAddr.return_city}
              onChange={e => setReturnAddr(p => ({ ...p, return_city: e.target.value }))} />
            <input className="lm-input lm-input--short" placeholder="State"
              value={returnAddr.return_state}
              onChange={e => setReturnAddr(p => ({ ...p, return_state: e.target.value }))} />
            <input className="lm-input lm-input--short" placeholder="ZIP"
              value={returnAddr.return_zip}
              onChange={e => setReturnAddr(p => ({ ...p, return_zip: e.target.value }))} />
          </div>
          <input className="lm-input" placeholder="Country (optional)"
            value={returnAddr.return_country}
            onChange={e => setReturnAddr(p => ({ ...p, return_country: e.target.value }))} />
        </div>
        <button className="lm-save-btn" onClick={saveReturnAddr} disabled={saving}>
          {saved ? "Saved ✓" : saving ? "Saving…" : "Save return address"}
        </button>
      </div>

      {/* Manual entry */}
      {mode === "manual" && (
        <div className="lm-section">
          <p className="lm-section-label">Destination address</p>
          <div className="lm-return-grid">
            <input className="lm-input lm-input--full" placeholder="Name / Business"
              value={manualDest.recipient}
              onChange={e => setManualDest(p => ({ ...p, recipient: e.target.value }))} />
            <input className="lm-input lm-input--full" placeholder="Address line 1"
              value={manualDest.address1}
              onChange={e => setManualDest(p => ({ ...p, address1: e.target.value }))} />
            <input className="lm-input lm-input--full" placeholder="Address line 2 (optional)"
              value={manualDest.address2}
              onChange={e => setManualDest(p => ({ ...p, address2: e.target.value }))} />
            <div className="lm-row">
              <input className="lm-input" placeholder="City"
                value={manualDest.city}
                onChange={e => setManualDest(p => ({ ...p, city: e.target.value }))} />
              <input className="lm-input lm-input--short" placeholder="State"
                value={manualDest.state}
                onChange={e => setManualDest(p => ({ ...p, state: e.target.value }))} />
              <input className="lm-input lm-input--short" placeholder="ZIP"
                value={manualDest.zip}
                onChange={e => setManualDest(p => ({ ...p, zip: e.target.value }))} />
            </div>
            <input className="lm-input" placeholder="Country (optional)"
              value={manualDest.country}
              onChange={e => setManualDest(p => ({ ...p, country: e.target.value }))} />
          </div>
          {!hasReturn && <p className="lm-warn">Fill in your return address above before printing.</p>}
          <button className="lm-print-btn" style={{ alignSelf: "flex-start" }}
            onClick={printManual} disabled={!manualReady}>
            Print label
          </button>
        </div>
      )}

      {/* Batch picker */}
      {mode === "fulfillment" && !selectedBatch ? (
        <div className="lm-section">
          <p className="lm-section-label">Select a fulfillment batch</p>
          {batches.length === 0
            ? <p className="lm-empty">No fulfillment batches yet.</p>
            : <div className="lm-batch-list">
                {batches.map(b => (
                  <button key={b.id} className="lm-batch-chip" onClick={() => selectBatch(b)}>
                    <span className="lm-batch-name">{baseName(b.filename)}</span>
                    <span className="lm-batch-meta">{formatDate(b.imported_at)} · {b.order_count} order{b.order_count !== 1 ? "s" : ""}</span>
                  </button>
                ))}
              </div>
          }
        </div>
      ) : mode === "fulfillment" && (
        <div className="lm-section lm-order-section">
          <div className="lm-order-header">
            <div className="lm-order-header-left">
              <button className="lm-back-btn" onClick={() => { setSelectedBatch(null); setOrders([]); }}>← Back</button>
              <p className="lm-section-label">{baseName(selectedBatch!.filename)}</p>
            </div>
            <div className="lm-order-header-right">
              <button className="lm-select-all-btn" onClick={toggleAll}>
                {selectedIds.size === orders.length ? "Deselect all" : "Select all"}
              </button>
              <button className="lm-print-btn" onClick={printLabels}
                disabled={selectedIds.size === 0 || !hasReturn}>
                Print {selectedIds.size} label{selectedIds.size !== 1 ? "s" : ""}
              </button>
            </div>
          </div>

          {!hasReturn && (
            <p className="lm-warn">Fill in your return address above before printing.</p>
          )}

          <div className="lm-order-list">
            {orders.map(o => {
              const checked = selectedIds.has(o.order_id);
              const addrLine = [o.address1, o.city, o.state, o.zip].filter(Boolean).join(", ");
              return (
                <label key={o.order_id} className={`lm-order-row${checked ? " lm-order-row--checked" : ""}`}>
                  <input type="checkbox" checked={checked} onChange={() => toggleOrder(o.order_id)} />
                  <div className="lm-order-info">
                    <span className="lm-order-name">{o.recipient}</span>
                    <span className="lm-order-addr">{addrLine}</span>
                  </div>
                  <span className="lm-order-num">#{o.ebay_order_number}</span>
                </label>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
