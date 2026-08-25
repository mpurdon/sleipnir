import type { CSSProperties, PropsWithChildren } from "react";
import { chamferClipPath, DEFAULT_CORNERS, type Corner } from "./chamferPath";

export function Chamfer({
  cut = 8,
  corners = DEFAULT_CORNERS,
  className,
  style,
  children,
}: PropsWithChildren<{
  cut?: number;
  corners?: Corner[];
  className?: string;
  style?: CSSProperties;
}>) {
  return (
    <div
      className={className}
      style={{ ...style, clipPath: chamferClipPath(cut, corners) }}
    >
      {children}
    </div>
  );
}
