import type { CSSProperties, PropsWithChildren } from "react";
import type { Corner } from "./chamferPath";
import "./Slab.css";

/**
 * Panel background: a carved iron slab — bevelled border in the tint
 * colour, inner tooling groove. `cut`/`corners` are accepted for
 * call-site compatibility with the old chamfered version but no longer
 * shape anything.
 */
export function Slab({
  tint = "var(--c-edge)",
  cut: _cut,
  corners: _corners,
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
  return (
    <div className="slab" style={{ ...style, "--slab-tint": tint } as CSSProperties}>
      <div className={`slab-content ${className ?? ""}`}>{children}</div>
    </div>
  );
}
