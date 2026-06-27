import { useCallback, useEffect, useRef, useState } from "react";
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

interface SelBox { x: number; y: number; w: number; h: number }

function extractCollectionValue(item: InventoryItemRow): string | null {
  if (!item.custom_label || !item.segment_labels?.length) return null;
  const idx = item.segment_labels.findIndex(
    (l) => l.toLowerCase() === "collection"
  );
  const parts = item.custom_label.split("-");
  const value = parts[idx === -1 ? 0 : idx];
  return value || null;
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

  // Selection state
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [selBox, setSelBox] = useState<SelBox | null>(null);
  const [bulkConfirmDelete, setBulkConfirmDelete] = useState(false);
  const isDraggingRef = useRef(false);
  const dragStartRef = useRef({ x: 0, y: 0 });
  const selBoxRef = useRef<SelBox | null>(null);
  const tbodyRef = useRef<HTMLTableSectionElement>(null);
  const lastClickedIdRef = useRef<number | null>(null);

  // Rubber-band drag via window listeners
  useEffect(() => {
    function onMouseMove(e: MouseEvent) {
      if (!isDraggingRef.current) return;
      const { x: sx, y: sy } = dragStartRef.current;
      const box: SelBox = {
        x: Math.min(sx, e.clientX),
        y: Math.min(sy, e.clientY),
        w: Math.abs(e.clientX - sx),
        h: Math.abs(e.clientY - sy),
      };
      selBoxRef.current = box;
      setSelBox({ ...box });
    }

    function onMouseUp(e: MouseEvent) {
      if (!isDraggingRef.current) return;
      isDraggingRef.current = false;
      const box = selBoxRef.current;
      selBoxRef.current = null;
      setSelBox(null);

      // Threshold: ignore tiny drags (treat as clicks, handled by row onClick)
      if (!box || (box.w < 6 && box.h < 6)) return;

      if (!tbodyRef.current) return;
      const newIds = new Set<number>();
      tbodyRef.current.querySelectorAll<HTMLTableRowElement>("tr[data-id]").forEach((row) => {
        const r = row.getBoundingClientRect();
        if (r.left < box.x + box.w && r.right > box.x &&
            r.top  < box.y + box.h && r.bottom > box.y) {
          newIds.add(Number(row.dataset.id));
        }
      });

      setSelectedIds((prev) =>
        e.shiftKey || e.ctrlKey || e.metaKey
          ? new Set([...prev, ...newIds])
          : newIds
      );
    }

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, []);

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

  // ── Row interactions ──────────────────────────────────────────────────────

  function handleTableMouseDown(e: React.MouseEvent) {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button,input,select,a")) return;
    e.preventDefault();
    isDraggingRef.current = true;
    dragStartRef.current = { x: e.clientX, y: e.clientY };
  }

  function handleRowClick(e: React.MouseEvent, id: number, index: number) {
    if ((e.target as HTMLElement).closest("button")) return;

    if (e.shiftKey && lastClickedIdRef.current !== null) {
      // Range select between last clicked and this row
      const lastIndex = items.findIndex((it) => it.id === lastClickedIdRef.current);
      const [lo, hi] = lastIndex < index ? [lastIndex, index] : [index, lastIndex];
      const rangeIds = items.slice(lo, hi + 1).map((it) => it.id);
      setSelectedIds((prev) => new Set([...prev, ...rangeIds]));
    } else if (e.ctrlKey || e.metaKey) {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        next.has(id) ? next.delete(id) : next.add(id);
        return next;
      });
    } else {
      setSelectedIds((prev) => {
        const next = new Set<number>();
        if (!prev.has(id) || prev.size > 1) next.add(id);
        return next;
      });
    }
    lastClickedIdRef.current = id;
  }

  function toggleSelectAll() {
    if (selectedIds.size === items.length && items.length > 0) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(items.map((it) => it.id)));
    }
  }

  // ── Import ────────────────────────────────────────────────────────────────

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

  // ── Single-row delete ─────────────────────────────────────────────────────

  async function confirmDelete(id: number) {
    setPendingDelete(null);
    try {
      await invoke("delete_inventory_item", { id });
      await loadData();
    } catch (e) {
      setStatusMsg({ text: `Delete failed: ${e}`, kind: "err" });
    }
  }

  // ── Bulk actions ──────────────────────────────────────────────────────────

  async function handleBulkDelete() {
    const ids = [...selectedIds];
    setBulkConfirmDelete(false);
    setSelectedIds(new Set());
    try {
      await invoke("bulk_delete_inventory_items", { ids });
      await loadData();
    } catch (e) {
      setStatusMsg({ text: `Bulk delete failed: ${e}`, kind: "err" });
    }
  }

  async function handleBulkStatus(status: string) {
    const ids = [...selectedIds];
    try {
      await invoke("bulk_update_inventory_status", { ids, status });
      await loadData();
    } catch (e) {
      setStatusMsg({ text: `Status update failed: ${e}`, kind: "err" });
    }
  }

  const allSelected = items.length > 0 && selectedIds.size === items.length;
  const someSelected = selectedIds.size > 0;

  return (
    <div className="inv">
      {/* Rubber-band selection rectangle */}
      {selBox && selBox.w > 2 && selBox.h > 2 && (
        <div
          className="inv-sel-rect"
          style={{ left: selBox.x, top: selBox.y, width: selBox.w, height: selBox.h }}
        />
      )}

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

      {/* Bulk action bar */}
      {someSelected && (
        <div className="inv-bulk-bar">
          {bulkConfirmDelete ? (
            <>
              <span className="inv-bulk-warn">Delete {selectedIds.size} items?</span>
              <button className="inv-bulk-confirm-yes" onClick={handleBulkDelete}>Yes, delete</button>
              <button className="inv-bulk-confirm-no" onClick={() => setBulkConfirmDelete(false)}>Cancel</button>
            </>
          ) : (
            <>
              <span className="inv-bulk-count">{selectedIds.size} selected</span>
              <div className="inv-bulk-actions">
                <button className="inv-bulk-btn" onClick={() => handleBulkStatus("listed")}>Mark Listed</button>
                <button className="inv-bulk-btn" onClick={() => handleBulkStatus("unlisted")}>Mark Unlisted</button>
                <button className="inv-bulk-btn" onClick={() => handleBulkStatus("sold")}>Mark Sold</button>
                <button className="inv-bulk-btn inv-bulk-btn--danger" onClick={() => setBulkConfirmDelete(true)}>Delete</button>
                <button className="inv-bulk-clear" onClick={() => setSelectedIds(new Set())}>✕ Clear</button>
              </div>
            </>
          )}
        </div>
      )}

      <div
        className="inv-table-wrap"
        onMouseDown={handleTableMouseDown}
        style={{ userSelect: isDraggingRef.current ? "none" : undefined }}
      >
        <table className="inv-table">
          <thead>
            <tr>
              <th className="inv-th-check">
                <input
                  type="checkbox"
                  checked={allSelected}
                  ref={(el) => { if (el) el.indeterminate = someSelected && !allSelected; }}
                  onChange={toggleSelectAll}
                />
              </th>
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
          <tbody ref={tbodyRef}>
            {items.map((item, index) => {
              const selected = selectedIds.has(item.id);
              return (
                <tr
                  key={item.id}
                  data-id={item.id}
                  className={selected ? "inv-row--selected" : undefined}
                  onClick={(e) => handleRowClick(e, item.id, index)}
                >
                  <td className="inv-cell-check" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={selected}
                      onChange={() => {
                        setSelectedIds((prev) => {
                          const next = new Set(prev);
                          next.has(item.id) ? next.delete(item.id) : next.add(item.id);
                          return next;
                        });
                      }}
                    />
                  </td>
                  <td className="inv-cell-sku">{item.custom_label || "—"}</td>
                  <td className="inv-cell-schema">
                    {(() => {
                      const val = extractCollectionValue(item);
                      return val
                        ? <span className="inv-schema-tag" title={item.schema_name || undefined}>{val}</span>
                        : <span className="inv-schema-none">—</span>;
                    })()}
                  </td>
                  <td className="inv-cell-title">{item.title}</td>
                  <td>{item.card_name || "—"}</td>
                  <td>{item.set_name || "—"}</td>
                  <td>{item.condition || "—"}</td>
                  <td>{item.price != null ? `$${item.price.toFixed(2)}` : "—"}</td>
                  <td>
                    <span className={`inv-badge inv-badge--${item.status}`}>{item.status}</span>
                  </td>
                  <td className="inv-cell-actions" onClick={(e) => e.stopPropagation()}>
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
              );
            })}
            {items.length === 0 && (
              <tr>
                <td colSpan={10} className="inv-empty">
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
