import { useEffect, useRef, useState } from "react";
import { appPaths, openInFileManager, readLogs, type AppPaths } from "../lib/tauri";
import { parseLogText, type LogEntry } from "../lib/logs";
import { SectionRule } from "../theme";

function levelColor(level?: string): string {
  switch (level) {
    case "ERROR":
      return "var(--c-magenta)";
    case "WARN":
      return "var(--c-yellow)";
    case "INFO":
      return "var(--c-cyan)";
    default:
      return "var(--c-dim)";
  }
}

function LogRow({ entry }: { entry: LogEntry }) {
  const [expanded, setExpanded] = useState(false);
  const hasPayload = entry.payload !== undefined || !!entry.payloadRaw;
  const color = levelColor(entry.level);

  return (
    <div className="log-row">
      <button
        className={`log-row-head${hasPayload ? " hover-glow" : ""}`}
        onClick={() => hasPayload && setExpanded((e) => !e)}
        style={{ cursor: hasPayload ? "pointer" : "default" }}
      >
        <span className="label log-level" style={{ color }}>
          {entry.level ?? ""}
        </span>
        <span className="label log-time">{entry.time ?? ""}</span>
        <span className="label log-target">{entry.target ?? ""}</span>
        <span className="log-message">{entry.message}</span>
        {hasPayload && (
          <span className="label log-toggle" style={{ color: "var(--c-cyan)" }}>
            {expanded ? "▾ HIDE DETAILS" : "▸ DETAILS"}
          </span>
        )}
      </button>
      {expanded && hasPayload && (
        <pre className="log-payload">{entry.payload !== undefined ? JSON.stringify(entry.payload, null, 2) : entry.payloadRaw}</pre>
      )}
    </div>
  );
}

export function DeveloperTab() {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [paths, setPaths] = useState<AppPaths | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [onlyProblems, setOnlyProblems] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    appPaths()
      .then(setPaths)
      .catch((e) => console.error("app_paths failed", e));
  }, []);

  useEffect(() => {
    let cancelled = false;
    function tick() {
      readLogs(1000)
        .then((text) => {
          if (!cancelled) setEntries(parseLogText(text));
        })
        .catch((e) => console.error("read_logs failed", e));
    }
    tick();
    if (!autoRefresh) return;
    const id = setInterval(tick, 2000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [autoRefresh]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries]);

  const shown = onlyProblems ? entries.filter((e) => e.level === "WARN" || e.level === "ERROR") : entries;

  return (
    <div className="settings-section">
      <SectionRule title="Application logs" />

      <div className="dev-toolbar">
        <label className="checkbox-row" style={{ padding: 0 }}>
          <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} />
          <span className="label">LIVE</span>
        </label>
        <label className="checkbox-row" style={{ padding: 0 }}>
          <input type="checkbox" checked={onlyProblems} onChange={(e) => setOnlyProblems(e.target.checked)} />
          <span className="label">WARN/ERROR ONLY</span>
        </label>
        {paths && (
          <>
            <button
              className="label hover-glow"
              style={{ color: "var(--c-cyan)" }}
              onClick={() => openInFileManager(paths.logDir)}
            >
              OPEN LOG FOLDER
            </button>
            <button
              className="label hover-glow"
              style={{ color: "var(--c-cyan)" }}
              onClick={() => openInFileManager(paths.configPath)}
            >
              OPEN CONFIG FILE
            </button>
          </>
        )}
      </div>

      <div className="log-viewer" ref={scrollRef}>
        {shown.length === 0 ? (
          <div className="label" style={{ color: "var(--c-dim)" }}>
            (no logs yet)
          </div>
        ) : (
          shown.map((entry, i) => <LogRow key={i} entry={entry} />)
        )}
      </div>

      {paths && (
        <div className="label" style={{ color: "var(--c-dim)" }}>
          CONFIG: {paths.configPath}
          <br />
          LOGS: {paths.logDir}
        </div>
      )}
    </div>
  );
}
