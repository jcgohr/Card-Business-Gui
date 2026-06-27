import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./FulfillmentManager.css";

interface OrderItemRow {
  id: number;
  ebay_item_number: string;
  item_title: string;
  custom_label: string;
  quantity: number;
  sold_for: number | null;
  tracking_number: string;
  inventory_item_id: number | null;
  inventory_title: string;
}

interface OrderRow {
  id: number;
  ebay_order_number: string;
  buyer_username: string;
  buyer_name: string;
  ship_to_name: string;
  ship_to_city: string;
  ship_to_state: string;
  sale_date: string;
  status: string;
  items: OrderItemRow[];
}

interface PickSheetItem {
  order_id: number;
  order_number: string;
  recipient: string;
  custom_label: string;
  item_title: string;
  quantity: number;
}

interface ImportResult {
  rows_imported: number;
  already_existed: number;
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

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

type ViewMode = "orders" | "picksheet";

export default function FulfillmentManager() {
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [pickItems, setPickItems] = useState<PickSheetItem[]>([]);
  const [viewMode, setViewMode] = useState<ViewMode>("orders");
  const [statusFilter, setStatusFilter] = useState("");
  const [loading, setLoading] = useState(false);
  const [statusMsg, setStatusMsg] = useState<{ text: string; kind: "ok" | "err" } | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const loadOrders = useCallback(async () => {
    try {
      const result = await invoke<OrderRow[]>("get_orders_with_items", { status: statusFilter });
      setOrders(result);
    } catch (e) {
      setStatusMsg({ text: `Load error: ${e}`, kind: "err" });
    }
  }, [statusFilter]);

  const loadPickSheet = useCallback(async () => {
    try {
      const result = await invoke<PickSheetItem[]>("get_pick_sheet");
      setPickItems(result);
    } catch (e) {
      setStatusMsg({ text: `Pick sheet error: ${e}`, kind: "err" });
    }
  }, []);

  useEffect(() => { loadOrders(); }, [loadOrders]);
  useEffect(() => { loadPickSheet(); }, [loadPickSheet]);

  async function handleImport() {
    const path = await invoke<string | null>("select_file", {
      filterName: "CSV Files",
      filterExt: "csv",
    });
    if (!path) return;
    setLoading(true);
    setStatusMsg(null);
    try {
      const result = await invoke<ImportResult>("import_orders_csv", { path });
      const skippedNote = result.already_existed > 0
        ? ` (${result.already_existed} orders already in database)`
        : "";
      setStatusMsg({ text: `Imported ${result.rows_imported} order items.${skippedNote}`, kind: "ok" });
      await Promise.all([loadOrders(), loadPickSheet()]);
      setViewMode("picksheet");
    } catch (e) {
      setStatusMsg({ text: `Import failed: ${e}`, kind: "err" });
    } finally {
      setLoading(false);
    }
  }

  async function handleMarkPacked(orderId: number, e: React.MouseEvent) {
    e.stopPropagation();
    try {
      await invoke("mark_order_packed", { orderId });
      await Promise.all([loadOrders(), loadPickSheet()]);
    } catch (err) {
      setStatusMsg({ text: `Error: ${err}`, kind: "err" });
    }
  }

  function toggleExpand(id: number) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const counts = {
    all: orders.length,
    new: orders.filter((o) => o.status === "new").length,
    packed: orders.filter((o) => o.status === "packed").length,
  };

  // ── Pick sheet derived data ────────────────────────────────────────────────

  const withSku    = [...pickItems.filter((i) => i.custom_label)].sort((a, b) => compareSku(a.custom_label, b.custom_label));
  const withoutSku = pickItems.filter((i) => !i.custom_label);

  // Sequential order numbers: 1, 2, 3… assigned by first appearance in the sorted list
  const seenOrderIds: number[] = [];
  for (const item of [...withSku, ...withoutSku]) {
    if (!seenOrderIds.includes(item.order_id)) seenOrderIds.push(item.order_id);
  }
  const orderNumMap = new Map(seenOrderIds.map((id, idx) => [id, idx + 1]));

  // Group SKU items by their first segment (box identifier)
  const boxGroups: Map<string, PickSheetItem[]> = new Map();
  for (const item of withSku) {
    const box = item.custom_label.split("-")[0] ?? "";
    if (!boxGroups.has(box)) boxGroups.set(box, []);
    boxGroups.get(box)!.push(item);
  }

  const newOrderCount = counts.new;

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="ff">
      <div className="ff-header">
        <h2 className="ff-title">Fulfillment</h2>
        <div className="ff-header-right">
          <div className="ff-view-tabs">
            <button
              className={`ff-view-tab${viewMode === "orders" ? " ff-view-tab--active" : ""}`}
              onClick={() => setViewMode("orders")}
            >
              Orders
            </button>
            <button
              className={`ff-view-tab${viewMode === "picksheet" ? " ff-view-tab--active" : ""}`}
              onClick={() => setViewMode("picksheet")}
            >
              Pick Sheet
              {pickItems.length > 0 && (
                <span className="ff-view-tab-count">{pickItems.length}</span>
              )}
            </button>
          </div>
          <button className="ff-import-btn" onClick={handleImport} disabled={loading}>
            {loading ? "Importing…" : "Import Orders CSV"}
          </button>
        </div>
      </div>

      {statusMsg && (
        <div className={`ff-msg ff-msg--${statusMsg.kind}`}>{statusMsg.text}</div>
      )}

      {/* ── Orders view ────────────────────────────────────────────────────── */}

      {viewMode === "orders" && (
        <>
          <div className="ff-filters">
            <button
              className={`ff-filter-btn${statusFilter === "" ? " ff-filter-btn--active" : ""}`}
              onClick={() => setStatusFilter("")}
            >
              All <span className="ff-filter-count">{counts.all}</span>
            </button>
            <button
              className={`ff-filter-btn${statusFilter === "new" ? " ff-filter-btn--active" : ""}`}
              onClick={() => setStatusFilter("new")}
            >
              Unpacked <span className="ff-filter-count">{counts.new}</span>
            </button>
            <button
              className={`ff-filter-btn${statusFilter === "packed" ? " ff-filter-btn--active" : ""}`}
              onClick={() => setStatusFilter("packed")}
            >
              Packed <span className="ff-filter-count">{counts.packed}</span>
            </button>
          </div>

          <div className="ff-orders">
            {orders.map((order) => {
              const isExpanded = expanded.has(order.id);
              const displayName = order.ship_to_name || order.buyer_name || order.buyer_username;
              const location = [order.ship_to_city, order.ship_to_state].filter(Boolean).join(", ");
              return (
                <div key={order.id} className={`ff-order ff-order--${order.status}`}>
                  <div className="ff-order-row" onClick={() => toggleExpand(order.id)}>
                    <div className="ff-order-left">
                      <span className="ff-order-num">{order.ebay_order_number}</span>
                      <span className="ff-order-buyer">{displayName || "Unknown buyer"}</span>
                      {location && <span className="ff-order-location">{location}</span>}
                      {order.sale_date && <span className="ff-order-date">{order.sale_date}</span>}
                    </div>
                    <div className="ff-order-right">
                      <span className="ff-item-count">
                        {order.items.length} item{order.items.length !== 1 ? "s" : ""}
                      </span>
                      <span className={`ff-badge ff-badge--${order.status}`}>{order.status}</span>
                      {order.status === "new" && (
                        <button
                          className="ff-pack-btn"
                          onClick={(e) => handleMarkPacked(order.id, e)}
                        >
                          Mark Packed
                        </button>
                      )}
                      <span className="ff-expand-icon">{isExpanded ? "▲" : "▼"}</span>
                    </div>
                  </div>

                  {isExpanded && (
                    <div className="ff-items">
                      {order.items.length === 0 && (
                        <div className="ff-items-empty">No item data recorded.</div>
                      )}
                      {order.items.map((item) => (
                        <div key={item.id} className="ff-item">
                          <span className="ff-item-sku">{item.custom_label || "—"}</span>
                          <span className="ff-item-title">{item.item_title || "—"}</span>
                          {item.inventory_title && (
                            <span className="ff-item-match">→ {item.inventory_title}</span>
                          )}
                          <div className="ff-item-meta">
                            <span>×{item.quantity}</span>
                            {item.sold_for != null && <span>${item.sold_for.toFixed(2)}</span>}
                            {item.tracking_number && (
                              <span className="ff-item-tracking">{item.tracking_number}</span>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}

            {orders.length === 0 && (
              <div className="ff-empty">
                No orders found. Import an eBay order report CSV to get started.
              </div>
            )}
          </div>
        </>
      )}

      {/* ── Pick sheet view ────────────────────────────────────────────────── */}

      {viewMode === "picksheet" && (
        <div className="ff-picksheet">
          {pickItems.length === 0 ? (
            <div className="ff-empty">
              {newOrderCount === 0
                ? "No unpacked orders. Mark orders as packed once fulfilled."
                : "No items found in unpacked orders."}
            </div>
          ) : (
            <>
              {/* Print-only header — hidden on screen */}
              <div className="ff-ps-print-header">
                <span className="ff-ps-print-title">Pick Sheet</span>
                <span className="ff-ps-print-meta">
                  {new Date().toLocaleDateString()} &nbsp;·&nbsp;
                  {pickItems.length} item{pickItems.length !== 1 ? "s" : ""} across {newOrderCount} order{newOrderCount !== 1 ? "s" : ""}
                </span>
              </div>

              <div className="ff-ps-toolbar">
                <div className="ff-ps-summary">
                  {pickItems.length} item{pickItems.length !== 1 ? "s" : ""} across {newOrderCount} order{newOrderCount !== 1 ? "s" : ""}
                  {withoutSku.length > 0 && (
                    <span className="ff-ps-no-sku-note"> · {withoutSku.length} without a location</span>
                  )}
                </div>
                <button className="ff-ps-print-btn" onClick={() => window.print()}>
                  Print
                </button>
              </div>

              <div className="ff-ps-list">
                {/* Column headers */}
                <div className="ff-ps-col-headers">
                  <span>Location</span>
                  <span>Card</span>
                  <span>#</span>
                  <span>Recipient</span>
                  <span></span>
                </div>

                {/* SKU items grouped by box */}
                {[...boxGroups.entries()].map(([box, items]) => (
                  <div key={box} className="ff-ps-group">
                    <div className="ff-ps-group-header">{box}</div>
                    {items.map((item, idx) => (
                      <div key={idx} className="ff-ps-item">
                        <span className="ff-ps-sku">{item.custom_label}</span>
                        <span className="ff-ps-title">{item.item_title || "—"}</span>
                        <span className="ff-ps-order-num">{orderNumMap.get(item.order_id)}</span>
                        <span className="ff-ps-recipient">{item.recipient}</span>
                        {item.quantity > 1
                          ? <span className="ff-ps-qty">×{item.quantity}</span>
                          : <span />}
                      </div>
                    ))}
                  </div>
                ))}

                {/* Items with no SKU */}
                {withoutSku.length > 0 && (
                  <div className="ff-ps-group ff-ps-group--no-sku">
                    <div className="ff-ps-group-header">No location</div>
                    {withoutSku.map((item, idx) => (
                      <div key={idx} className="ff-ps-item">
                        <span className="ff-ps-sku ff-ps-sku--none">—</span>
                        <span className="ff-ps-title">{item.item_title || "—"}</span>
                        <span className="ff-ps-order-num">{orderNumMap.get(item.order_id)}</span>
                        <span className="ff-ps-recipient">{item.recipient}</span>
                        {item.quantity > 1
                          ? <span className="ff-ps-qty">×{item.quantity}</span>
                          : <span />}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
