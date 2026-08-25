/**
 * Tauri command errors reject with the *deserialized* Rust error object
 * (see src-tauri/src/error.rs's `#[serde(tag = "kind", content = "message")]`
 * AppError), not a JS `Error` — so naive `${e}` string interpolation prints
 * "[object Object]" instead of anything useful. This extracts the real
 * message regardless of what shape the rejection actually took.
 */
export function formatError(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  if (e && typeof e === "object") {
    const obj = e as Record<string, unknown>;
    if (typeof obj.message === "string") {
      return typeof obj.kind === "string" ? `${obj.kind}: ${obj.message}` : obj.message;
    }
    try {
      return JSON.stringify(e);
    } catch {
      // fall through
    }
  }
  return String(e);
}
