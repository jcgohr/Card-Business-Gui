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

interface ImportResult {
  rows_imported: number;
  already_existed: number;
}

export default function FulfillmentManager() {
  const [orders, setOrders] = useState<OrderRow[]>([]);
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

  useEffect(() => { loadOrders(); }, [loadOrders]);

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
      loadOrders();
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
      loadOrders();
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

  return (
    <div className="ff">
      <div className="ff-header">
        <h2 className="ff-title">Fulfillment</h2>
        <button className="ff-import-btn" onClick={handleImport} disabled={loading}>
          {loading ? "Importing…" : "Import Orders CSV"}
        </button>
      </div>

      {statusMsg && (
        <div className={`ff-msg ff-msg--${statusMsg.kind}`}>{statusMsg.text}</div>
      )}

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
    </div>
  );
}
