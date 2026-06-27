import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./InventoryManager.css";
import SchemaPickerModal from "./SchemaPickerModal";

interface InventoryItemRow {
  id: number;
  title: string;
  card_name: string;
  card_number: string;
  set_name: string;
  rarity: string;
  condition: string;
  price: number | null;
  tcg: string;
  custom_label: string;
  status: string;
  imported_at: string;
  sku_schema_id: number | null;
  schema_name: string;
  segment_labels: string[];
}

interface InventoryStats {
  total: number;
  listed: number;
  sold: number;
  unlisted: number;
}

interface ImportResult {
  rows_imported: number;
  already_existed: number;
}

export default function InventoryManager() {
  const [items, setItems] = useState<InventoryItemRow[]>([]);
  const [stats, setStats] = useState<InventoryStats>({ total: 0, listed: 0, sold: 0, unlisted: 0 });
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [loading, setLoading] = useState(false);
  const [statusMsg, setStatusMsg] = useState<{ text: string; kind: "ok" | "err" } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<number | null>(null);
  const [pendingImport, setPendingImport] = useState<{ path: string; filename: string } | null>(null);

  const loadData = useCallback(async () => {
    try {
      const [itemsResult, statsResult] = await Promise.all([
        invoke<InventoryItemRow[]>("get_inventory_items", { search, status: statusFilter }),
        invoke<InventoryStats>("get_inventory_stats"),
      ]);
      setItems(itemsResult);
      setStats(statsResult);
    } catch (e) {
      setStatusMsg({ text: `Load error: ${e}`, kind: "err" });
    }
  }, [search, statusFilter]);

  useEffect(() => { loadData(); }, [loadData]);

  async function handleImport() {
    const path = await invoke<string | null>("select_file", {
      filterName: "CSV Files",
      filterExt: "csv",
    });
    if (!path) return;
    const filename = path.split(/[\\/]/).pop() ?? path;
    setPendingImport({ path, filename });
  }

  async function doImport(schemaId: number | null) {
    if (!pendingImport) return;
    setPendingImport(null);
    setLoading(true);
    setStatusMsg(null);
    try {
      const result = await invoke<ImportResult>("import_inventory_csv", {
        path: pendingImport.path,
        schemaId,
      });
      setStatusMsg({
        text: `Imported ${result.rows_imported} items.${result.already_existed > 0 ? ` (${result.already_existed} skipped)` : ""}`,
        kind: "ok",
      });
      await loadData();
    } catch (e) {
      setStatusMsg({ text: `Import failed: ${e}`, kind: "err" });
    } finally {
      setLoading(false);
    }
  }

  async function confirmDelete(id: number) {
    setPendingDelete(null);
    try {
      await invoke("delete_inventory_item", { id });
      await loadData();
    } catch (e) {
      setStatusMsg({ text: `Delete failed: ${e}`, kind: "err" });
    }
  }

  return (
    <div className="inv">
      {pendingImport && (
        <SchemaPickerModal
          path={pendingImport.path}
          filename={pendingImport.filename}
          onConfirm={doImport}
          onCancel={() => setPendingImport(null)}
        />
      )}
      <div className="inv-header">
        <h2 className="inv-title">Inventory</h2>
        <button className="inv-import-btn" onClick={handleImport} disabled={loading}>
          {loading ? "Importing…" : "Import CSV"}
        </button>
      </div>

      {statusMsg && (
        <div className={`inv-msg inv-msg--${statusMsg.kind}`}>{statusMsg.text}</div>
      )}

      <div className="inv-stats">
        <div className="inv-stat">
          <span className="inv-stat-value">{stats.total}</span>
          <span className="inv-stat-label">Total</span>
        </div>
        <div className="inv-stat inv-stat--listed">
          <span className="inv-stat-value">{stats.listed}</span>
          <span className="inv-stat-label">Listed</span>
        </div>
        <div className="inv-stat inv-stat--sold">
          <span className="inv-stat-value">{stats.sold}</span>
          <span className="inv-stat-label">Sold</span>
        </div>
        <div className="inv-stat inv-stat--unlisted">
          <span className="inv-stat-value">{stats.unlisted}</span>
          <span className="inv-stat-label">Unlisted</span>
        </div>
      </div>

      <div className="inv-filters">
        <input
          type="text"
          className="inv-search"
          placeholder="Search title, card name, SKU, set…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          className="inv-status-filter"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
        >
          <option value="">All statuses</option>
          <option value="listed">Listed</option>
          <option value="sold">Sold</option>
          <option value="unlisted">Unlisted</option>
        </select>
      </div>

      <div className="inv-table-wrap">
        <table className="inv-table">
          <thead>
            <tr>
              <th>SKU</th>
              <th>Collection</th>
              <th>Title</th>
              <th>Card Name</th>
              <th>Set</th>
              <th>Condition</th>
              <th>Price</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                <td className="inv-cell-sku">{item.custom_label || "—"}</td>
                <td className="inv-cell-schema">
                  {item.schema_name
                    ? <span className="inv-schema-tag">{item.schema_name}</span>
                    : <span className="inv-schema-none">—</span>}
                </td>
                <td className="inv-cell-title">{item.title}</td>
                <td>{item.card_name || "—"}</td>
                <td>{item.set_name || "—"}</td>
                <td>{item.condition || "—"}</td>
                <td>{item.price != null ? `$${item.price.toFixed(2)}` : "—"}</td>
                <td>
                  <span className={`inv-badge inv-badge--${item.status}`}>{item.status}</span>
                </td>
                <td className="inv-cell-actions">
                  {pendingDelete === item.id ? (
                    <span className="inv-delete-confirm">
                      <button className="inv-confirm-yes" onClick={() => confirmDelete(item.id)}>Yes</button>
                      <button className="inv-confirm-no" onClick={() => setPendingDelete(null)}>No</button>
                    </span>
                  ) : (
                    <button
                      className="inv-delete-btn"
                      onClick={() => setPendingDelete(item.id)}
                      title="Delete item"
                    >
                      ✕
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {items.length === 0 && (
              <tr>
                <td colSpan={9} className="inv-empty">
                  {search || statusFilter
                    ? "No items match your search."
                    : "No inventory yet. Import a listing CSV to get started."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
