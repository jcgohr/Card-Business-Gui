import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import "./App.css";
import Sidebar from "./components/Sidebar";
import CardUploaderAutoUpload from "./components/CardUploaderAutoUpload";
import InventoryManager from "./components/InventoryManager";
import FulfillmentManager from "./components/FulfillmentManager";
import LabelMaker from "./components/LabelMaker";

const LOG_CAP = 500;

export interface LogLine {
  id: number;
  level: string;
  message: string;
}

export interface WatcherStatus {
  running: boolean;
  activeCount: number;
}

function App() {
  const [activeView, setActiveView] = useState("card-uploader-auto-upload");
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [watcherStatus, setWatcherStatus] = useState<WatcherStatus>({ running: false, activeCount: 0 });
  const [currentSection, setCurrentSection] = useState<number | null>(null);
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [updating, setUpdating] = useState(false);
  const idCounter = useRef(0);

  const addLog = useCallback((level: string, message: string) => {
    idCounter.current += 1;
    setLogs((prev) => {
      const next = [...prev, { id: idCounter.current, level, message }];
      return next.length > LOG_CAP ? next.slice(next.length - LOG_CAP) : next;
    });
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      check().then(update => {
        if (update?.available) setUpdateAvailable(true);
      }).catch(() => {});
    }, 3000);
    return () => clearTimeout(timer);
  }, []);

  async function installUpdate() {
    setUpdating(true);
    try {
      const update = await check();
      if (update?.available) {
        await update.downloadAndInstall();
        await relaunch();
      }
    } catch {
      setUpdating(false);
    }
  }

  useEffect(() => {
    const unlisten1 = listen<{ level: string; message: string }>(
      "log-message",
      ({ payload }) => addLog(payload.level, payload.message)
    );

    const unlisten2 = listen<{ running: boolean; active_count: number }>(
      "watcher-status",
      ({ payload }) => {
        setWatcherStatus({ running: payload.running, activeCount: payload.active_count });
      }
    );

    const unlisten3 = listen<{ section: number }>("section-updated", ({ payload }) => {
      setCurrentSection(payload.section);
    });

    return () => {
      unlisten1.then((f) => f());
      unlisten2.then((f) => f());
      unlisten3.then((f) => f());
    };
  }, []);

  return (
    <div className="app-shell">
      {updateAvailable && (
        <div className="app-update-banner">
          A new version is available.
          <button className="app-update-btn" onClick={installUpdate} disabled={updating}>
            {updating ? "Installing…" : "Update & restart"}
          </button>
          <button className="app-update-dismiss" onClick={() => setUpdateAvailable(false)}>✕</button>
        </div>
      )}
      <div className="app-body">
      <Sidebar activeId={activeView} onSelect={setActiveView} />
      <main className="app-main">
        {activeView === "card-uploader-auto-upload" && (
          <CardUploaderAutoUpload
            logs={logs}
            onAddLog={addLog}
            onClearLogs={() => setLogs([])}
            watcherStatus={watcherStatus}
            externalSection={currentSection}
          />
        )}
        {activeView === "inventory" && <InventoryManager />}
        {activeView === "fulfillment" && <FulfillmentManager />}
        {activeView === "label-maker" && <LabelMaker />}
      </main>
      </div>
    </div>
  );
}

export default App;
