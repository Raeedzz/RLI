import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "ghost" | "danger";
type Size = "sm" | "md";

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  children: ReactNode;
}

const VARIANT_BG: Record<Variant, { rest: string; hover: string }> = {
  primary: { rest: "var(--accent)", hover: "var(--accent-hover)" },
  ghost: { rest: "transparent", hover: "var(--surface-3)" },
  danger: {
    rest: "var(--state-error-bg)",
    hover: "color-mix(in oklch, var(--state-error-bg), var(--state-error) 12%)",
  },
};

const VARIANT_FG: Record<Variant, string> = {
  primary: "var(--text-inverse)",
  ghost: "var(--text-secondary)",
  danger: "var(--state-error)",
};

const VARIANT_BORDER: Record<Variant, string> = {
  primary: "1px solid transparent",
  ghost: "var(--border-1)",
  danger: "1px solid var(--state-error)",
};

export function Button({
  variant = "ghost",
  size = "md",
  children,
  style,
  ...rest
}: Props) {
  const bg = VARIANT_BG[variant];
  const padY = size === "sm" ? "0 var(--space-3)" : "0 var(--space-4)";
  const height = size === "sm" ? 24 : 28;

  return (
    <button
      type="button"
      className="gli-press"
      {...rest}
      style={{
        height,
        padding: padY,
        display: "inline-flex",
        alignItems: "center",
        gap: "var(--space-2)",
        fontFamily: "var(--font-sans)",
        fontSize: "var(--text-sm)",
        fontWeight: "var(--weight-medium)",
        letterSpacing: "var(--tracking-base)",
        color: VARIANT_FG[variant],
        backgroundColor: bg.rest,
        border: VARIANT_BORDER[variant],
        borderRadius: "var(--radius-sm)",
        cursor: "default",
        whiteSpace: "nowrap",
        transition:
          "background-color var(--motion-instant) var(--ease-out-quart)",
        ...style,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.backgroundColor = bg.hover;
        rest.onMouseEnter?.(e);
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.backgroundColor = bg.rest;
        rest.onMouseLeave?.(e);
      }}
    >
      {children}
    </button>
  );
}
