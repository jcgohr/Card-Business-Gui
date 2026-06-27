import { useEffect, useRef, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./CardUploaderAutoUpload.css";
import type { LogLine, WatcherStatus } from "../App";

// ── Constants ─────────────────────────────────────────────────────────────────

const TCG_OPTIONS: Record<string, string> = {
  "English Pokemon": "pokemon english",
  "Japanese Pokemon": "pokemon japanese",
  "Chinese Pokemon (Beta)": "test chinese",
  "Digimon Japanese OCG": "digimon",
  "English Yu-Gi-Oh": "english yugioh",
  "Riftbound": "riftbound",
  "Lorcana": "lorcana",
  "MetaZoo": "metazoo",
  "One Piece English": "one piece english",
  "One Piece Japanese": "one piece japanese",
  "Magic: The Gathering": "mtg",
  "Dragon Ball Super English": "dragon ball super english",
  "Flesh and Blood": "flesh and blood",
  "Final Fantasy": "final fantasy",
  "Star Wars Unlimited": "star wars unlimited",
  "Weiss Schwarz": "weiss schwarz",
  "Cardfight!! Vanguard": "cardfight vanguard",
};

const PLATFORM_OPTIONS: Record<string, string> = {
  "eBay Auctions": "auction",
  "eBay Fixed Price": "standard",
  "eBay Variation": "variation",
  "Shopify": "shopify",
  "Whatnot": "whatnot",
  "TCGPlayer": "tcgplayer",
  "Extras": "extras",
};

const CONDITION_OPTIONS: Record<string, string> = {
  "Near Mint (NM)": "NM",
  "Lightly Played (LP)": "LP",
  "Moderately Played (MP)": "MP",
  "Heavily Played (HP)": "HP",
  "Damaged (DMG)": "DMG",
};

function apiToDisplay(map: Record<string, string>, value: string): string {
  return Object.entries(map).find(([, v]) => v === value)?.[0]
    ?? Object.keys(map)[0];
}

// ── Types ──────────────────────────────────────────────────────────────────────

interface Config {
  watch_folder: string;
  email: string;
  password: string;
  tcg: string;
  platform: string;
  condition: string;
  start_price: string;
  box_prefix: string;
  current_section: number;
  sku_increment: boolean;
  auto_crop: boolean;
  images_per_card: number;
  auction_duration: number;
  space_out_enabled: boolean;
  space_out_interval: number;
  best_offer: number;
  store_category: string;
  store_category2: string;
  auction_scheduled_time: string;
  fixed_price_scheduled_time: string;
  matching_exclude_sets: string[];
  matching_prioritize_sets: string[];
  matching_exclude_terms: string[];
  matching_prioritize_terms: string[];
  image_extensions: string[];
  folder_settle_delay: number;
  blacklisted_folders: string[];
}

const DEFAULT_CONFIG: Config = {
  watch_folder: "",
  email: "",
  password: "",
  tcg: "pokemon japanese",
  platform: "standard",
  condition: "NM",
  start_price: "0.99",
  box_prefix: "",
  current_section: 1,
  sku_increment: true,
  auto_crop: true,
  images_per_card: 2,
  auction_duration: 7,
  space_out_enabled: false,
  space_out_interval: 5,
  best_offer: 0,
  store_category: "",
  store_category2: "",
  auction_scheduled_time: "",
  fixed_price_scheduled_time: "",
  matching_exclude_sets: [],
  matching_prioritize_sets: [],
  matching_exclude_terms: [],
  matching_prioritize_terms: [],
  image_extensions: [".jpg", ".jpeg", ".png", ".webp"],
  folder_settle_delay: 5,
  blacklisted_folders: [],
};

// ── Component ──────────────────────────────────────────────────────────────────

interface Props {
  logs: LogLine[];
  onAddLog: (level: string, message: string) => void;
  onClearLogs: () => void;
  watcherStatus: WatcherStatus;
  externalSection: number | null;
}

export default function CardUploaderAutoUpload({ logs, onAddLog, onClearLogs, watcherStatus, externalSection }: Props) {
  const [config, setConfig] = useState<Config>(DEFAULT_CONFIG);
  const [skuPreview, setSkuPreview] = useState("1-1");
  const [blacklistInput, setBlacklistInput] = useState("");
  const logEndRef = useRef<HTMLDivElement>(null);

  // Load config on mount
  useEffect(() => {
    invoke<Config>("load_config").then((c) => setConfig(c)).catch(() => {});
  }, []);

  // Apply section increments emitted by the backend
  useEffect(() => {
    if (externalSection !== null) {
      setConfig((prev) => ({ ...prev, current_section: externalSection }));
    }
  }, [externalSection]);

  // Auto-scroll log whenever new lines arrive
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs.length]);

  // Live SKU preview
  useEffect(() => {
    invoke<string>("get_sku_preview", {
      boxPrefix: config.box_prefix,
      currentSection: config.current_section,
    }).then(setSkuPreview).catch(() => {});
  }, [config.box_prefix, config.current_section]);

  const set = useCallback(<K extends keyof Config>(key: K, value: Config[K]) => {
    setConfig((prev) => ({ ...prev, [key]: value }));
  }, []);


  async function handleSave() {
    try {
      await invoke("save_config", { config });
      onAddLog("info", "Config saved.");
    } catch (e) {
      onAddLog("error", `Save failed: ${e}`);
    }
  }

  async function handleTestAuth() {
    onAddLog("info", "Testing authentication...");
    try {
      const msg = await invoke<string>("test_auth", { config });
      onAddLog("info", msg);
    } catch (e) {
      onAddLog("error", `Auth failed: ${e}`);
    }
  }

  async function handleBrowse() {
    const path = await invoke<string | null>("select_directory");
    if (path) set("watch_folder", path);
  }

  async function handleStart() {
    if (!config.email || !config.password) {
      onAddLog("error", "Email and password are required.");
      return;
    }
    if (!config.watch_folder) {
      onAddLog("error", "Watch folder is required.");
      return;
    }
    await handleSave();
    try {
      await invoke("start_watcher", { config });
    } catch (e) {
      onAddLog("error", `Start failed: ${e}`);
    }
  }

  async function handleStop() {
    try {
      await invoke("stop_watcher");
    } catch (e) {
      onAddLog("error", `Stop failed: ${e}`);
    }
  }

  async function handleProcessFolder() {
    const path = await invoke<string | null>("select_directory");
    if (!path) return;
    if (!config.email || !config.password) {
      onAddLog("error", "Email and password are required.");
      return;
    }
    try {
      await invoke("process_folder_manual", { folderPath: path, config });
    } catch (e) {
      onAddLog("error", `Process folder failed: ${e}`);
    }
  }

  async function handleProcessAll() {
    const path = await invoke<string | null>("select_directory");
    if (!path) return;
    if (!config.email || !config.password) {
      onAddLog("error", "Email and password are required.");
      return;
    }
    try {
      await invoke("process_all_subfolders", { parentPath: path, config });
    } catch (e) {
      onAddLog("error", `Process all failed: ${e}`);
    }
  }

  function addBlacklist() {
    const name = blacklistInput.trim();
    if (!name) return;
    const lower = name.toLowerCase();
    if (!config.blacklisted_folders.some((f) => f.toLowerCase() === lower)) {
      set("blacklisted_folders", [...config.blacklisted_folders, name]);
    }
    setBlacklistInput("");
  }

  function removeBlacklist(name: string) {
    set("blacklisted_folders", config.blacklisted_folders.filter((f) => f !== name));
  }

  const { running: watcherRunning, activeCount } = watcherStatus;

  const statusText = watcherRunning && activeCount > 0
    ? "Watching + Processing"
    : watcherRunning
    ? "Watching"
    : activeCount > 0
    ? "Processing"
    : "Idle";

  const statusActive = watcherRunning || activeCount > 0;

  return (
    <div className="cau-root">
      {/* ── Header ── */}
      <div className="cau-header">
        <h2 className="cau-title">CardUploader AutoUpload</h2>
        <div className="cau-header-actions">
          <button
            className="cau-btn cau-btn--start"
            onClick={handleStart}
            disabled={watcherRunning}
          >
            ▶ Start
          </button>
          <button
            className="cau-btn cau-btn--stop"
            onClick={handleStop}
            disabled={!watcherRunning && activeCount === 0}
          >
            ■ Stop
          </button>
          <button className="cau-btn cau-btn--purple" onClick={handleProcessFolder}>
            Process Folder
          </button>
          <button className="cau-btn cau-btn--teal" onClick={handleProcessAll}>
            Process All
          </button>
          <span className={`cau-status ${statusActive ? "cau-status--active" : ""}`}>
            ● {statusText}
          </span>
        </div>
      </div>

      <div className="cau-body">
        {/* ── Settings ── */}
        <div className="cau-settings">

          <p className="cau-section-label">Account</p>
          <label className="cau-field">
            <span>Email</span>
            <input type="email" value={config.email} onChange={(e) => set("email", e.target.value)} />
          </label>
          <label className="cau-field">
            <span>Password</span>
            <input type="password" value={config.password} onChange={(e) => set("password", e.target.value)} />
          </label>
          <button className="cau-btn cau-btn--ghost cau-btn--sm" onClick={handleTestAuth}>
            Test Auth
          </button>

          <p className="cau-section-label">Watch Folder</p>
          <div className="cau-field cau-field--row">
            <input
              className="cau-flex"
              type="text"
              value={config.watch_folder}
              onChange={(e) => set("watch_folder", e.target.value)}
              placeholder="/path/to/folder"
            />
            <button className="cau-btn cau-btn--ghost cau-btn--sm" onClick={handleBrowse}>
              Browse
            </button>
          </div>
          <label className="cau-field">
            <span>Settle delay (s)</span>
            <input
              type="number"
              min={1}
              value={config.folder_settle_delay}
              onChange={(e) => set("folder_settle_delay", Number(e.target.value))}
            />
          </label>

          <p className="cau-section-label">Card Settings</p>
          <label className="cau-field">
            <span>TCG</span>
            <select
              value={apiToDisplay(TCG_OPTIONS, config.tcg)}
              onChange={(e) => set("tcg", TCG_OPTIONS[e.target.value] ?? e.target.value)}
            >
              {Object.keys(TCG_OPTIONS).map((k) => <option key={k}>{k}</option>)}
            </select>
          </label>
          <label className="cau-field">
            <span>Platform</span>
            <select
              value={apiToDisplay(PLATFORM_OPTIONS, config.platform)}
              onChange={(e) => set("platform", PLATFORM_OPTIONS[e.target.value] ?? e.target.value)}
            >
              {Object.keys(PLATFORM_OPTIONS).map((k) => <option key={k}>{k}</option>)}
            </select>
          </label>
          <label className="cau-field">
            <span>Condition</span>
            <select
              value={apiToDisplay(CONDITION_OPTIONS, config.condition)}
              onChange={(e) => set("condition", CONDITION_OPTIONS[e.target.value] ?? e.target.value)}
            >
              {Object.keys(CONDITION_OPTIONS).map((k) => <option key={k}>{k}</option>)}
            </select>
          </label>
          <label className="cau-field">
            <span>Start Price ($)</span>
            <input type="text" value={config.start_price} onChange={(e) => set("start_price", e.target.value)} />
          </label>

          <p className="cau-section-label">SKU</p>
          <label className="cau-field">
            <span>Box Prefix</span>
            <input
              type="text"
              value={config.box_prefix}
              placeholder="e.g. fb1-etb1"
              onChange={(e) => set("box_prefix", e.target.value)}
            />
          </label>
          <div className="cau-field">
            <span>Section #</span>
            <div className="cau-stepper">
              <button
                className="cau-btn cau-btn--ghost cau-btn--sm"
                onClick={() => set("current_section", Math.max(1, config.current_section - 1))}
              >−</button>
              <input
                type="number"
                min={1}
                value={config.current_section}
                onChange={(e) => set("current_section", Number(e.target.value))}
              />
              <button
                className="cau-btn cau-btn--ghost cau-btn--sm"
                onClick={() => set("current_section", config.current_section + 1)}
              >+</button>
            </div>
          </div>
          <div className="cau-field">
            <span>SKU Preview</span>
            <span className="cau-sku-preview">{skuPreview}</span>
          </div>
          <label className="cau-checkbox">
            <input type="checkbox" checked={config.sku_increment} onChange={(e) => set("sku_increment", e.target.checked)} />
            Increment SKU per folder
          </label>
          <label className="cau-checkbox">
            <input type="checkbox" checked={config.auto_crop} onChange={(e) => set("auto_crop", e.target.checked)} />
            Auto Crop
          </label>
          <div className="cau-field">
            <span>Images per card</span>
            <div className="cau-radio-group">
              {["1", "2"].map((v) => (
                <label key={v} className="cau-radio">
                  <input
                    type="radio"
                    name="images_per_card"
                    value={v}
                    checked={config.images_per_card === Number(v)}
                    onChange={() => set("images_per_card", Number(v))}
                  />
                  {v}
                </label>
              ))}
            </div>
          </div>

          <p className="cau-section-label">Listing Defaults</p>
          <label className="cau-field">
            <span>Auction duration (days)</span>
            <input type="number" min={1} value={config.auction_duration} onChange={(e) => set("auction_duration", Number(e.target.value))} />
          </label>
          <label className="cau-checkbox">
            <input type="checkbox" checked={config.space_out_enabled} onChange={(e) => set("space_out_enabled", e.target.checked)} />
            Space out listings
          </label>
          <label className="cau-field">
            <span>Space out interval (min)</span>
            <input type="number" min={1} value={config.space_out_interval} onChange={(e) => set("space_out_interval", Number(e.target.value))} />
          </label>
          <label className="cau-field">
            <span>Best offer ($, 0 = off)</span>
            <input type="number" min={0} value={config.best_offer} onChange={(e) => set("best_offer", Number(e.target.value))} />
          </label>

          <p className="cau-section-label">Blacklisted Folders</p>
          <p className="cau-hint">Folders the watcher will skip</p>
          <div className="cau-blacklist">
            {config.blacklisted_folders.map((name) => (
              <div key={name} className="cau-blacklist-item">
                <span>{name}</span>
                <button onClick={() => removeBlacklist(name)}>×</button>
              </div>
            ))}
          </div>
          <div className="cau-field cau-field--row">
            <input
              className="cau-flex"
              type="text"
              placeholder="Folder name"
              value={blacklistInput}
              onChange={(e) => setBlacklistInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addBlacklist()}
            />
            <button className="cau-btn cau-btn--ghost cau-btn--sm" onClick={addBlacklist}>
              + Add
            </button>
          </div>

          <button className="cau-btn cau-btn--save" onClick={handleSave}>
            Save Config
          </button>
        </div>

        {/* ── Log ── */}
        <div className="cau-log-panel">
          <div className="cau-log-output">
            {logs.map((line) => (
              <div key={line.id} className={`cau-log-line cau-log-line--${line.level}`}>
                {line.message}
              </div>
            ))}
            <div ref={logEndRef} />
          </div>
          <div className="cau-log-footer">
            <button className="cau-btn cau-btn--ghost cau-btn--sm" onClick={onClearLogs}>
              Clear Log
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
