import type { ReactNode } from "react";
import type { DrawerSide } from "../lib/drawerWindow";
import closeIcon from "../assets/close.png";

/** Slide-out panel chrome: title bar with a close ✕, content scrolls. */
export function Drawer({
  title,
  side,
  anim,
  onClose,
  children,
}: {
  title: string;
  side: DrawerSide;
  /** "in" slides out from under the rail; "out" slides back before unmount. */
  anim: "in" | "out";
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <section className={`drawer drawer-${side} anim-${anim}`}>
      <div className="drawer-head">
        <span className="label" style={{ color: "var(--c-cyan)" }}>
          {title}
        </span>
        <button className="win-btn hover-glow" title="Close drawer" onClick={onClose}>
          <img src={closeIcon} alt="" className="close-icon" draggable={false} />
        </button>
      </div>
      <div className="drawer-body">{children}</div>
    </section>
  );
}
