/**
 * A meter drawn as discrete cells rather than a continuous bar — reads as
 * instrumentation, and makes small differences legible at a glance. Ported
 * from `SegmentedMeter` in vpb's CyberTheme.swift. Reused for both the Org
 * token-validity countdown and the multi-account Engage progress meter.
 */
export function SegmentedMeter({
  fraction,
  segments = 24,
  color = "var(--c-cyan)",
  height = 7,
}: {
  fraction: number;
  segments?: number;
  color?: string;
  height?: number;
}) {
  const lit = Math.floor(Math.max(0, Math.min(1, fraction)) * segments);

  return (
    <div style={{ display: "flex", gap: 2 }}>
      {Array.from({ length: segments }, (_, i) => (
        <div
          key={i}
          style={{
            flex: 1,
            height,
            background: i < lit ? color : "var(--c-edge)",
            opacity: i < lit ? 1 : 0.45,
            transition: "background 150ms ease-out, opacity 150ms ease-out",
          }}
        />
      ))}
    </div>
  );
}
