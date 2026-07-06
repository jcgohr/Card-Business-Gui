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
  finish: string;
  specialty: string;
  condition: string;
  price: number | null;
  tcg: string;
  language: string;
  illustrator: string;
  year: string;
  stage: string;
  description: string;
  custom_label: string;
  status: string;
  imported_at: string;
  sku_schema_id: number | null;
  schema_name: string;
  segment_labels: string[];
  pic_urls: string[];
  card_type: string;
  graded: string;
  color: string;
  character: string;
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
  ebay_csv_path: string | null;
  deduped_count: number;
  revise_rows_added: number;
}

interface ActiveListingImportResult {
  rows_imported: number;
  rows_replaced: number;
}

interface SyncStatus {
  last_active_at: string;
  inventory_imports_since_active: number;
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
  const [activeListingsCount, setActiveListingsCount] = useState<number>(0);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>({ last_active_at: "", inventory_imports_since_active: 0 });
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [loading, setLoading] = useState(false);
  const [statusMsg, setStatusMsg] = useState<{ text: string; kind: "ok" | "err" } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<number | null>(null);
  const [pendingImport, setPendingImport] = useState<{ path: string; filename: string } | null>(null);
  const [pendingBulkImport, setPendingBulkImport] = useState<{ path: string; filename: string }[] | null>(null);
  const [skuConflicts, setSkuConflicts] = useState<{ sku: string; files: string[]; in_db: boolean }[] | null>(null);
  const [pendingImportArgs, setPendingImportArgs] = useState<{ files: { path: string; filename: string }[]; schemaId: number | null; keepFirstSku: boolean; format: "carddealerpro" | "carduploader"; chaosLocation: string | null } | null>(null);
  const [confirmClearActive, setConfirmClearActive] = useState(false);

  // Detail panel
  const [detailItem, setDetailItem] = useState<InventoryItemRow | null>(null);

  // Selection state
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [selBox, setSelBox] = useState<SelBox | null>(null);
  const [bulkConfirmDelete, setBulkConfirmDelete] = useState(false);
  const isDraggingRef = useRef(false);
  const dragStartRef = useRef({ x: 0, y: 0 });
  const selBoxRef = useRef<SelBox | null>(null);
  const tbodyRef = useRef<HTMLTableSectionElement>(null);
  const lastClickedIdRef = useRef<number | null>(null);

  // Arrow key navigation through list (when detail panel is open)
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      if (!detailItem || items.length === 0) return;
      // Don't steal arrow keys from inputs
      if ((e.target as HTMLElement).closest("input,select,textarea")) return;

      e.preventDefault();

      const currentIndex = items.findIndex((it) => it.id === detailItem.id);
      if (currentIndex === -1) return;

      const nextIndex = e.key === "ArrowDown"
        ? Math.min(currentIndex + 1, items.length - 1)
        : Math.max(currentIndex - 1, 0);

      if (nextIndex === currentIndex) return;

      const nextItem = items[nextIndex];
      setSelectedIds(new Set([nextItem.id]));
      setDetailItem(nextItem);
      lastClickedIdRef.current = nextItem.id;

      tbodyRef.current
        ?.querySelector<HTMLTableRowElement>(`tr[data-id="${nextItem.id}"]`)
        ?.scrollIntoView({ block: "nearest" });
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [items, detailItem]);

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
      const [itemsResult, statsResult, activeCount, sync] = await Promise.all([
        invoke<InventoryItemRow[]>("get_inventory_items", { search, status: statusFilter }),
        invoke<InventoryStats>("get_inventory_stats"),
        invoke<number>("get_active_listings_count"),
        invoke<SyncStatus>("get_sync_status"),
      ]);
      setItems(itemsResult);
      setStats(statsResult);
      setActiveListingsCount(activeCount);
      setSyncStatus(sync);
      // Keep detail panel in sync if its item was updated
      setDetailItem((prev) => prev ? (itemsResult.find((i) => i.id === prev.id) ?? null) : null);
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

  function handleRowClick(e: React.MouseEvent, item: InventoryItemRow, index: number) {
    if ((e.target as HTMLElement).closest("button")) return;
    const { id } = item;

    if (e.shiftKey && lastClickedIdRef.current !== null) {
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
      // Plain click: select only this row and open detail panel
      const alreadySolo = selectedIds.size === 1 && selectedIds.has(id);
      if (alreadySolo) {
        setSelectedIds(new Set());
        setDetailItem(null);
      } else {
        setSelectedIds(new Set([id]));
        setDetailItem(item);
      }
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
    try {
      const path = await invoke<string | null>("select_file", {
        filterName: "CSV Files",
        filterExt: "csv",
      });
      if (!path) return;
      const filename = path.split(/[\\/]/).pop() ?? path;
      setPendingImport({ path, filename });
    } catch (e) {
      setStatusMsg({ text: `Failed to open file picker: ${e}`, kind: "err" });
    }
  }

  async function runImport(files: { path: string; filename: string }[], schemaId: number | null, keepFirstSku: boolean, format: "carddealerpro" | "carduploader", chaosLocation: string | null) {
    setLoading(true);
    setStatusMsg(null);
    let totalImported = 0;
    let totalRevise = 0;
    let totalDeduped = 0;
    const errors: string[] = [];
    for (const file of files) {
      try {
        const result = await invoke<ImportResult>("import_inventory_csv", {
          path: file.path,
          schemaId,
          keepFirstSku,
          format,
          chaosLocation,
        });
        totalImported += result.rows_imported;
        totalRevise   += result.revise_rows_added;
        totalDeduped  += result.deduped_count;
      } catch (e) {
        errors.push(`${file.filename}: ${e}`);
      }
    }
    const plural = files.length > 1;
    let msg = `Imported ${totalImported} items${plural ? ` from ${files.length} files` : ""}.`;
    if (format === "carduploader") msg += plural ? " CSVs updated for eBay upload." : " CSV updated for eBay upload.";
    if (totalRevise > 0) msg += ` ${totalDeduped} SKU${totalDeduped !== 1 ? "s" : ""} deduped — ${totalRevise} Revise row${totalRevise !== 1 ? "s" : ""} added.`;
    if (errors.length) msg += ` Errors: ${errors.join("; ")}`;
    setStatusMsg({ text: msg, kind: errors.length ? "err" : "ok" });
    await loadData();
    setLoading(false);
  }

  async function checkAndImport(files: { path: string; filename: string }[], schemaId: number | null, keepFirstSku: boolean, format: "carddealerpro" | "carduploader", chaosLocation: string | null) {
    try {
      const pathPairs = files.map(f => [f.path, f.filename] as [string, string]);
      const result = await invoke<{ conflicts: { sku: string; files: string[]; in_db: boolean }[] }>(
        "check_sku_conflicts",
        { paths: pathPairs, format, chaosLocation }
      );
      if (result.conflicts.length > 0) {
        setSkuConflicts(result.conflicts);
        setPendingImportArgs({ files, schemaId, keepFirstSku, format, chaosLocation });
        return;
      }
    } catch {
      // If check fails, proceed anyway
    }
    await runImport(files, schemaId, keepFirstSku, format, chaosLocation);
  }

  async function handleBulkImport() {
    try {
      const paths = await invoke<string[]>("select_files", {
        filterName: "CSV Files",
        filterExt: "csv",
      });
      if (!paths.length) return;
      const files = paths.map(p => ({ path: p, filename: p.split(/[\\/]/).pop() ?? p }));
      setPendingBulkImport(files);
    } catch (e) {
      setStatusMsg({ text: `Failed to open file picker: ${e}`, kind: "err" });
    }
  }

  async function doBulkImport(schemaId: number | null, keepFirstSku: boolean, format: "carddealerpro" | "carduploader", chaosLocation: string | null) {
    const files = pendingBulkImport;
    if (!files) return;
    setPendingBulkImport(null);
    await checkAndImport(files, schemaId, keepFirstSku, format, chaosLocation);
  }

  async function doImport(schemaId: number | null, keepFirstSku: boolean, format: "carddealerpro" | "carduploader", chaosLocation: string | null) {
    if (!pendingImport) return;
    const file = pendingImport;
    setPendingImport(null);
    await checkAndImport([file], schemaId, keepFirstSku, format, chaosLocation);
  }

  async function handleImportActiveListings() {
    try {
      const path = await invoke<string | null>("select_file", {
        filterName: "CSV Files",
        filterExt: "csv",
      });
      if (!path) return;
      setLoading(true);
      setStatusMsg(null);
      const result = await invoke<ActiveListingImportResult>("import_active_listings_csv", { path });
      setStatusMsg({
        text: `Active listings loaded: ${result.rows_imported} listings stored. Duplicate detection is now active.`,
        kind: "ok",
      });
      await loadData();
    } catch (e) {
      setStatusMsg({ text: `Active listings import failed: ${e}`, kind: "err" });
    } finally {
      setLoading(false);
    }
  }

  async function handleClearActiveListings() {
    setConfirmClearActive(false);
    try {
      await invoke("clear_active_listings");
      setStatusMsg({ text: "Active listings cleared. Duplicate detection disabled.", kind: "ok" });
      await loadData();
    } catch (e) {
      setStatusMsg({ text: `Clear failed: ${e}`, kind: "err" });
    }
  }

  // ── Single-row delete ─────────────────────────────────────────────────────

  async function confirmDelete(id: number) {
    setPendingDelete(null);
    try {
      await invoke("delete_inventory_item", { id });
      if (detailItem?.id === id) setDetailItem(null);
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
    if (detailItem && ids.includes(detailItem.id)) setDetailItem(null);
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

      {pendingBulkImport && (
        <SchemaPickerModal
          path={pendingBulkImport[0].path}
          filename={`${pendingBulkImport.length} files — ${pendingBulkImport[0].filename}, …`}
          onConfirm={doBulkImport}
          onCancel={() => setPendingBulkImport(null)}
        />
      )}

      {skuConflicts && pendingImportArgs && (
        <div className="inv-conflict-backdrop" onClick={() => { setSkuConflicts(null); setPendingImportArgs(null); }}>
          <div className="inv-conflict-modal" onClick={e => e.stopPropagation()}>
            <p className="inv-conflict-title">SKU conflicts detected</p>
            <div className="inv-conflict-list">
              {skuConflicts.slice(0, 20).map(c => (
                <div key={c.sku} className="inv-conflict-item">
                  <span className="inv-conflict-sku">{c.sku}</span>
                  <span className="inv-conflict-tags">
                    {c.in_db && <span className="inv-conflict-tag inv-conflict-tag--db">already in DB</span>}
                    {c.files.length > 1 && <span className="inv-conflict-tag inv-conflict-tag--dup">duplicate in upload</span>}
                  </span>
                </div>
              ))}
              {skuConflicts.length > 20 && (
                <p className="inv-conflict-more">…and {skuConflicts.length - 20} more</p>
              )}
            </div>
            <div className="inv-conflict-footer">
              <button className="inv-conflict-cancel" onClick={() => { setSkuConflicts(null); setPendingImportArgs(null); }}>
                Cancel
              </button>
              <button className="inv-conflict-proceed" onClick={async () => {
                const args = pendingImportArgs;
                setSkuConflicts(null);
                setPendingImportArgs(null);
                await runImport(args.files, args.schemaId, args.keepFirstSku, args.format, args.chaosLocation);
              }}>
                Import anyway
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="inv-header">
        <h2 className="inv-title">Inventory</h2>
        <div className="inv-header-actions">
          <div className="inv-active-listings">
            {activeListingsCount > 0 ? (
              <>
                <span
                  className="inv-active-badge"
                  title="Duplicate detection active — uploads will be checked against these listings"
                >
                  {activeListingsCount} active listings
                </span>
                {syncStatus.inventory_imports_since_active > 0 && (
                  <span
                    className="inv-active-stale"
                    title={`${syncStatus.inventory_imports_since_active} listing CSV${syncStatus.inventory_imports_since_active !== 1 ? "s" : ""} uploaded since active listings were refreshed — duplicate listings may be created`}
                  >
                    {syncStatus.inventory_imports_since_active} upload{syncStatus.inventory_imports_since_active !== 1 ? "s" : ""} since refresh
                  </span>
                )}
                {confirmClearActive ? (
                  <>
                    <span className="inv-active-clear-warn">Clear?</span>
                    <button className="inv-active-clear-yes" onClick={handleClearActiveListings}>Yes</button>
                    <button className="inv-active-clear-no" onClick={() => setConfirmClearActive(false)}>No</button>
                  </>
                ) : (
                  <button className="inv-active-clear-btn" onClick={() => setConfirmClearActive(true)} title="Remove stored active listings">✕</button>
                )}
              </>
            ) : (
              <span className="inv-active-none" title="Import your eBay active listings report to enable duplicate detection">No active listings</span>
            )}
            <button className="inv-active-import-btn" onClick={handleImportActiveListings} disabled={loading}>
              {activeListingsCount > 0 ? "Refresh Active" : "Load Active Listings"}
            </button>
          </div>
          <button className="inv-import-btn" onClick={handleImport} disabled={loading}>
            Import CSV
          </button>
          <button className="inv-import-btn inv-bulk-import-btn" onClick={handleBulkImport} disabled={loading}>
            Bulk Import
          </button>
        </div>
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
        <div className="inv-search-wrap">
          <input
            type="text"
            className="inv-search"
            placeholder="Search title, card name, SKU, set…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {search && (
            <button className="inv-search-clear" onClick={() => setSearch("")}>✕</button>
          )}
        </div>
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

      <div className="inv-body">
        <div
          className="inv-table-wrap"
          onMouseDown={handleTableMouseDown}
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
                    onClick={(e) => handleRowClick(e, item, index)}
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

        {detailItem && (
          <div className="inv-detail-panel">
            <div className="inv-detail-header">
              <span className="inv-detail-heading">Details</span>
              <button className="inv-detail-close" onClick={() => { setDetailItem(null); setSelectedIds(new Set()); }}>✕</button>
            </div>

            {(detailItem.pic_urls ?? []).length > 0 ? (
              <div className="inv-detail-img-wrap">
                {(detailItem.pic_urls ?? []).slice(0, 2).map((url, i) => (
                  <div key={i} className="inv-detail-img-card">
                    <span className="inv-detail-img-label">{i === 0 ? "Front" : "Back"}</span>
                    <img src={url} alt={i === 0 ? "Front" : "Back"} className="inv-detail-img" />
                  </div>
                ))}
              </div>
            ) : (
              <div className="inv-detail-no-img">No image</div>
            )}

            <div className="inv-detail-fields">
              <div className="inv-detail-field">
                <span className="inv-detail-label">SKU</span>
                <span className="inv-detail-value inv-detail-value--mono">{detailItem.custom_label || "—"}</span>
              </div>
              {detailItem.schema_name && (
                <div className="inv-detail-field">
                  <span className="inv-detail-label">Schema</span>
                  <span className="inv-detail-value">{detailItem.schema_name}</span>
                </div>
              )}
              <div className="inv-detail-field">
                <span className="inv-detail-label">Status</span>
                <span className={`inv-badge inv-badge--${detailItem.status}`}>{detailItem.status}</span>
              </div>
              <div className="inv-detail-field">
                <span className="inv-detail-label">Price</span>
                <span className="inv-detail-value">
                  {detailItem.price != null ? `$${detailItem.price.toFixed(2)}` : "—"}
                </span>
              </div>
              <div className="inv-detail-field inv-detail-field--col">
                <span className="inv-detail-label">Title</span>
                <span className="inv-detail-value">{detailItem.title || "—"}</span>
              </div>
              <div className="inv-detail-field">
                <span className="inv-detail-label">Card Name</span>
                <span className="inv-detail-value">{detailItem.card_name || "—"}</span>
              </div>
              <div className="inv-detail-field">
                <span className="inv-detail-label">Card Number</span>
                <span className="inv-detail-value">{detailItem.card_number || "—"}</span>
              </div>
              <div className="inv-detail-field">
                <span className="inv-detail-label">Set</span>
                <span className="inv-detail-value">{detailItem.set_name || "—"}</span>
              </div>
              <div className="inv-detail-field">
                <span className="inv-detail-label">Rarity</span>
                <span className="inv-detail-value">{detailItem.rarity || "—"}</span>
              </div>
              <div className="inv-detail-field">
                <span className="inv-detail-label">Condition</span>
                <span className="inv-detail-value">{detailItem.condition || "—"}</span>
              </div>
              <div className="inv-detail-field">
                <span className="inv-detail-label">Finish</span>
                <span className="inv-detail-value">{detailItem.finish || "—"}</span>
              </div>
              <div className="inv-detail-field">
                <span className="inv-detail-label">Specialty</span>
                <span className="inv-detail-value">{detailItem.specialty || "—"}</span>
              </div>
              <div className="inv-detail-field">
                <span className="inv-detail-label">Stage</span>
                <span className="inv-detail-value">{detailItem.stage || "—"}</span>
              </div>
              <div className="inv-detail-field">
                <span className="inv-detail-label">Language</span>
                <span className="inv-detail-value">{detailItem.language || "—"}</span>
              </div>
              <div className="inv-detail-field">
                <span className="inv-detail-label">TCG</span>
                <span className="inv-detail-value">{detailItem.tcg || "—"}</span>
              </div>
              <div className="inv-detail-field">
                <span className="inv-detail-label">Year</span>
                <span className="inv-detail-value">{detailItem.year || "—"}</span>
              </div>
              <div className="inv-detail-field">
                <span className="inv-detail-label">Illustrator</span>
                <span className="inv-detail-value">{detailItem.illustrator || "—"}</span>
              </div>
              <div className="inv-detail-field">
                <span className="inv-detail-label">Card Type</span>
                <span className="inv-detail-value">{detailItem.card_type || "—"}</span>
              </div>
              <div className="inv-detail-field">
                <span className="inv-detail-label">Character</span>
                <span className="inv-detail-value">{detailItem.character || "—"}</span>
              </div>
              <div className="inv-detail-field">
                <span className="inv-detail-label">Color</span>
                <span className="inv-detail-value">{detailItem.color || "—"}</span>
              </div>
              <div className="inv-detail-field">
                <span className="inv-detail-label">Graded</span>
                <span className="inv-detail-value">{detailItem.graded || "—"}</span>
              </div>
              <div className="inv-detail-field inv-detail-field--col">
                <span className="inv-detail-label">Description</span>
                <span className="inv-detail-value inv-detail-value--desc">{detailItem.description || "—"}</span>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
