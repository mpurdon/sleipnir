import { useState } from "react";
import { createPortal } from "react-dom";
import type { LoginProgress } from "../lib/tauri";
import { Slab } from "../theme";

/**
 * Shown while a device-authorization login is waiting for browser approval.
 *
 * The point is the code. AWS asks you to confirm that the code on its page
 * matches the one the application is showing; without the app half, there is
 * nothing to compare against and the check silently degrades into "click
 * approve on whatever page opened" — which is exactly the step device-auth
 * phishing relies on.
 *
 * It stays up through the polling stage too, because the flow moves there a
 * second or two after the browser opens, while the comparison is still
 * happening.
 */
export function LoginApprovalModal({
  orgName,
  progress,
}: {
  orgName: string;
  progress: LoginProgress;
}) {
  const [copied, setCopied] = useState<"code" | "link" | null>(null);
  /** Dismissing hides the overlay but does not cancel the login — an
   * abandoned device code stays pending with AWS for several minutes, and
   * covering the rail for that long would strand the user. The rail keeps
   * showing the code, so nothing is lost by closing this. Survives the
   * polling re-renders because the component instance is not remounted. */
  const [dismissed, setDismissed] = useState(false);

  if (dismissed) return null;
  if (progress.stage !== "awaitingBrowserApproval" && progress.stage !== "polling") return null;
  const { userCode, verificationUriComplete } = progress;

  async function copy(kind: "code" | "link", value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(kind);
      setTimeout(() => setCopied((c) => (c === kind ? null : c)), 1400);
    } catch {
      /* clipboard unavailable — the code is readable on screen regardless */
    }
  }

  // Portalled for the same reason as the connection-test modal: the rail and
  // drawer each form a stacking context and the rail clips overflow.
  return createPortal(
    <div className="modal-overlay">
      <Slab tint="var(--c-cyan)" cut={6} className="login-modal">
        <div className="rail-group-head">
          <span className="label" style={{ color: "var(--c-cyan)" }}>
            APPROVE IN BROWSER · {orgName.toUpperCase()}
          </span>
          <button
            className="label hover-glow"
            style={{ color: "var(--c-dim)" }}
            title="Hide this — the code stays visible in the rail"
            onClick={() => setDismissed(true)}
          >
            ✕
          </button>
        </div>

        <div className="label login-modal-instruction">
          Check this code matches the one shown in your browser before approving.
        </div>

        <button
          className="login-code hover-glow"
          title="Copy the code"
          onClick={() => void copy("code", userCode)}
        >
          {userCode}
        </button>

        <div className="label" style={{ color: copied === "code" ? "var(--c-lime)" : "var(--c-dim)" }}>
          {copied === "code" ? "✓ CODE COPIED" : "CLICK THE CODE TO COPY IT"}
        </div>

        <div className="label login-modal-note">
          If they do not match, do not approve — close the browser page and start the login again.
        </div>

        <button
          className="label hover-glow login-modal-link"
          style={{ color: copied === "link" ? "var(--c-lime)" : "var(--c-dim)" }}
          title={verificationUriComplete}
          onClick={() => void copy("link", verificationUriComplete)}
        >
          {copied === "link" ? "✓ LINK COPIED" : "COPY APPROVAL LINK"}
        </button>
      </Slab>
    </div>,
    document.body,
  );
}
