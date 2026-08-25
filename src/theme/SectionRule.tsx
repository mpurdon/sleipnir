/** Section heading: a label, a fading rule, and a runic terminator. */
export function SectionRule({ title, color = "var(--c-dim)" }: { title: string; color?: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span className="label" style={{ color, letterSpacing: 1.4 }}>
        {title.toUpperCase()}
      </span>
      <span
        style={{
          flex: 1,
          height: 1,
          background: "linear-gradient(to right, var(--c-edge), transparent)",
        }}
      />
      <span aria-hidden style={{ color, opacity: 0.55, fontSize: 9, lineHeight: 1 }}>
        ᛭
      </span>
    </div>
  );
}
