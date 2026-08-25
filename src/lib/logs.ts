// Mirrors src-tauri/src/applog.rs's convention: a plain fern-formatted line,
// optionally followed by ` ||PAYLOAD||<json>` carrying structured detail
// (request/response payloads, full AWS error debug output, etc.) that would
// otherwise be lost to a terse one-line message.

export type LogLevel = "TRACE" | "DEBUG" | "INFO" | "WARN" | "ERROR";

export interface LogEntry {
  raw: string;
  date?: string;
  time?: string;
  target?: string;
  level?: LogLevel;
  message: string;
  payload?: unknown;
  payloadRaw?: string;
}

const LINE_RE = /^\[([\d-]+)\]\[([\d:]+)\]\[([^\]]+)\]\[(\w+)\] (.*)$/;
const PAYLOAD_MARKER = " ||PAYLOAD||";

export function parseLogLine(raw: string): LogEntry {
  const m = raw.match(LINE_RE);
  let date: string | undefined;
  let time: string | undefined;
  let target: string | undefined;
  let level: string | undefined;
  let rest = raw;
  if (m) {
    [, date, time, target, level, rest] = m as unknown as [string, string, string, string, string, string];
  }

  const idx = rest.indexOf(PAYLOAD_MARKER);
  let message = rest;
  let payloadRaw: string | undefined;
  if (idx !== -1) {
    message = rest.slice(0, idx);
    payloadRaw = rest.slice(idx + PAYLOAD_MARKER.length);
  }

  let payload: unknown;
  if (payloadRaw) {
    try {
      payload = JSON.parse(payloadRaw);
    } catch {
      // leave undefined — the row falls back to showing payloadRaw verbatim
    }
  }

  return { raw, date, time, target, level: level as LogLevel | undefined, message, payload, payloadRaw };
}

export function parseLogText(text: string): LogEntry[] {
  return text
    .split("\n")
    .filter((l) => l.length > 0)
    .map(parseLogLine);
}
