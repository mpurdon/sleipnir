import { useState } from "react";
import { createPortal } from "react-dom";
import { openUrl } from "@tauri-apps/plugin-opener";
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
  onCancel,
}: {
  orgName: string;
  progress: LoginProgress;
  onCancel: () => void;
}) {
  const [copied, setCopied] = useState<"code" | "link" | null>(null);
  const [cancelling, setCancelling] = useState(false);

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
            {orgName.toUpperCase()} · LOGIN
          </span>
          <button
            className="label hover-glow"
            style={{ color: cancelling ? "var(--c-dim)" : "var(--c-magenta)" }}
            title="Stop waiting and abandon this login"
            disabled={cancelling}
            onClick={() => {
              setCancelling(true);
              onCancel();
            }}
          >
            {cancelling ? "CANCELLING…" : "✕ CANCEL"}
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

        {/* Closing the browser window used to be unrecoverable: the code
            stays pending with AWS for its full lifetime, but there was no
            way back to the page it belongs to. */}
        <div className="login-modal-actions">
          <button
            className="label hover-glow login-modal-link"
            style={{ color: "var(--c-cyan)" }}
            title="Open the approval page again"
            onClick={() => void openUrl(verificationUriComplete).catch(() => copy("link", verificationUriComplete))}
          >
            ↗ REOPEN BROWSER
          </button>
          <button
            className="label hover-glow login-modal-link"
            style={{ color: copied === "link" ? "var(--c-lime)" : "var(--c-dim)" }}
            title={verificationUriComplete}
            onClick={() => void copy("link", verificationUriComplete)}
          >
            {copied === "link" ? "✓ LINK COPIED" : "COPY LINK"}
          </button>
        </div>
      </Slab>
    </div>,
    document.body,
  );
}
