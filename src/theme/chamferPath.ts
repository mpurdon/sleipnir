export type Corner = "topLeft" | "topRight" | "bottomLeft" | "bottomRight";

export const DEFAULT_CORNERS: Corner[] = ["topLeft", "bottomRight"];

/**
 * 45°-cut-corner clip-path, ported from `Chamfer: Shape` in vpb's
 * CyberTheme.swift. Coordinates mix `%` and `px` per point, which
 * `clip-path: polygon()` allows directly — no viewBox/aspect-ratio
 * distortion to worry about, unlike an SVG overlay.
 */
export function chamferClipPath(cut: number, corners: Corner[] = DEFAULT_CORNERS): string {
  const has = (c: Corner) => corners.includes(c);
  const cpx = `${cut}px`;
  const pts: string[] = [];

  pts.push(has("topLeft") ? `${cpx} 0` : `0 0`);
  pts.push(has("topRight") ? `calc(100% - ${cpx}) 0` : `100% 0`);
  if (has("topRight")) pts.push(`100% ${cpx}`);
  pts.push(has("bottomRight") ? `100% calc(100% - ${cpx})` : `100% 100%`);
  if (has("bottomRight")) pts.push(`calc(100% - ${cpx}) 100%`);
  pts.push(has("bottomLeft") ? `${cpx} 100%` : `0 100%`);
  if (has("bottomLeft")) pts.push(`0 calc(100% - ${cpx})`);
  pts.push(has("topLeft") ? `0 ${cpx}` : `0 0`);

  return `polygon(${pts.join(", ")})`;
}
