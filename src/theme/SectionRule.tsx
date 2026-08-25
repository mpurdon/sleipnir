/** Section heading: a label, a rule, and a small terminator tick. */
export function SectionRule({ title, color = "var(--c-dim)" }: { title: string; color?: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <span className="label" style={{ color, letterSpacing: 1.4 }}>
        {title.toUpperCase()}
      </span>
      <span style={{ flex: 1, height: 1, background: "var(--c-edge)" }} />
      <span style={{ width: 3, height: 3, background: color, opacity: 0.7 }} />
    </div>
  );
}
