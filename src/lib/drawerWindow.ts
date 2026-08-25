import { currentMonitor, getCurrentWindow, LogicalPosition, LogicalSize } from "@tauri-apps/api/window";

export const DRAWER_W = 680;
export const MIN_RAIL_W = 340;

export type DrawerSide = "left" | "right";

async function geometry() {
  const win = getCurrentWindow();
  const scale = await win.scaleFactor();
  const pos = (await win.outerPosition()).toLogical(scale);
  const size = (await win.innerSize()).toLogical(scale);
  return { win, pos, size };
}

/** Which side of the current monitor has room for the drawer. */
export async function chooseSide(): Promise<DrawerSide> {
  const { pos, size } = await geometry();
  const monitor = await currentMonitor();
  if (!monitor) return "right";
  const mPos = monitor.position.toLogical(monitor.scaleFactor);
  const mSize = monitor.size.toLogical(monitor.scaleFactor);
  const roomRight = mPos.x + mSize.width - (pos.x + size.width);
  const roomLeft = pos.x - mPos.x;
  return roomRight >= DRAWER_W || roomRight >= roomLeft ? "right" : "left";
}

/** How long the drawer's CSS slide runs — keep in sync with App.css. */
export const DRAWER_ANIM_MS = 240;

/**
 * The frame itself changes in ONE resize (a single dark repaint — the
 * native backing matches the theme, so it's imperceptible). All visible
 * motion is the drawer's GPU-composited CSS transform, which animating
 * the native frame could never match for smoothness.
 */
export async function expandFrame(side: DrawerSide): Promise<void> {
  const { win, pos, size } = await geometry();
  if (side === "left") {
    await win.setPosition(new LogicalPosition(pos.x - DRAWER_W, pos.y));
  }
  await win.setSize(new LogicalSize(size.width + DRAWER_W, size.height));
}

/**
 * Two-phase shrink: all geometry IPC happens up front (before the slide
 * starts), returning an executor that performs the single setSize with no
 * reads left to do. Firing that executor one frame before the CSS slide
 * lands makes the frame snap coincide with the slide's end — no visible
 * beat of empty space between "drawer gone" and "window shrunk".
 */
export async function prepareCollapse(side: DrawerSide): Promise<() => Promise<void>> {
  const { win, pos, size } = await geometry();
  const target = Math.max(MIN_RAIL_W, size.width - DRAWER_W);
  return async () => {
    await win.setSize(new LogicalSize(target, size.height));
    if (side === "left") {
      await win.setPosition(new LogicalPosition(pos.x + (size.width - target), pos.y));
    }
  };
}

export async function minimizeWindow(): Promise<void> {
  await getCurrentWindow().minimize();
}

export async function closeWindow(): Promise<void> {
  await getCurrentWindow().close();
}
