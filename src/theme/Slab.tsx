import type { CSSProperties, PropsWithChildren } from "react";
import { chamferClipPath, DEFAULT_CORNERS, type Corner } from "./chamferPath";
import "./Slab.css";

/**
 * Panel background: chamfered slab with a hairline edge and faint
 * scanlines, ported from `Slab: ViewModifier` in vpb's CyberTheme.swift.
 *
 * The "border" is two stacked chamfered layers (full-size = tint colour,
 * inset 1px = panel fill) rather than an actual CSS border, since
 * `clip-path` has no stroke of its own.
 */
export function Slab({
  tint = "var(--c-edge)",
  cut = 8,
  corners = DEFAULT_CORNERS,
  className,
  style,
  children,
}: PropsWithChildren<{
  tint?: string;
  cut?: number;
  corners?: Corner[];
  className?: string;
  style?: CSSProperties;
}>) {
  const clip = chamferClipPath(cut, corners);
  return (
    <div className="slab" style={style}>
      <div className="slab-border" style={{ clipPath: clip, background: tint }} />
      <div className="slab-fill" style={{ clipPath: clip }}>
        <div className="slab-scanlines" />
      </div>
      <div className={`slab-content ${className ?? ""}`}>{children}</div>
    </div>
  );
}
