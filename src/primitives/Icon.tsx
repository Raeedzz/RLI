import type { SVGProps } from "react";

/**
 * Hand-rolled SVG icons used in chrome surfaces. 16px viewbox,
 * 1.5px stroke, designed to read crisp on macOS retina at the 16–18px
 * sizes we use (rail buttons, pane headers, palette rows).
 *
 * `currentColor` everywhere so the icon picks up CSS color from
 * its parent — keeps tokens flowing.
 */

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function base({ size = 16, ...rest }: IconProps) {
  return {
    width: size,
    height: size,
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.5,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    ...rest,
  };
}

export function FolderIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M2 5.5C2 4.7 2.7 4 3.5 4h2.4c.4 0 .7.1 1 .4l1.2 1.1H12.5c.8 0 1.5.7 1.5 1.5v4.5c0 .8-.7 1.5-1.5 1.5h-9C2.7 13 2 12.3 2 11.5V5.5Z" />
    </svg>
  );
}

export function SearchIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="7" cy="7" r="4.25" />
      <path d="M10.25 10.25 13.5 13.5" />
    </svg>
  );
}

export function ConnectionsIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="3.5" cy="8" r="1.75" />
      <circle cx="12.5" cy="3.5" r="1.75" />
      <circle cx="12.5" cy="12.5" r="1.75" />
      <path d="M5.1 7.1 10.9 4.4" />
      <path d="M5.1 8.9 10.9 11.6" />
    </svg>
  );
}

export function BrowserIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="M2 6.5 H14" />
      <circle cx="4" cy="4.75" r="0.4" fill="currentColor" stroke="none" />
      <circle cx="5.5" cy="4.75" r="0.4" fill="currentColor" stroke="none" />
      <circle cx="7" cy="4.75" r="0.4" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function GitIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="4" cy="3.5" r="1.5" />
      <circle cx="4" cy="12.5" r="1.5" />
      <circle cx="12" cy="8" r="1.5" />
      <path d="M4 5 V11" />
      <path d="M5.5 8 H10.5" />
    </svg>
  );
}

export function SettingsIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="8" cy="8" r="2" />
      <path d="M8 1.5 V3.5" />
      <path d="M8 12.5 V14.5" />
      <path d="M14.5 8 H12.5" />
      <path d="M3.5 8 H1.5" />
      <path d="M12.6 3.4 11.2 4.8" />
      <path d="M4.8 11.2 3.4 12.6" />
      <path d="M12.6 12.6 11.2 11.2" />
      <path d="M4.8 4.8 3.4 3.4" />
    </svg>
  );
}

export function TerminalIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="M5 7 L7 8.5 L5 10" />
      <path d="M8.5 10.5 H11" />
    </svg>
  );
}

export function FileIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M9 2 H4.5C3.7 2 3 2.7 3 3.5v9c0 .8.7 1.5 1.5 1.5h7c.8 0 1.5-.7 1.5-1.5V6 L9 2 Z" />
      <path d="M9 2 V6 H13" />
    </svg>
  );
}

export function GraphIcon(props: IconProps) {
  // Three nodes connected by edges — reads as a memory/embedding graph.
  return (
    <svg {...base(props)}>
      <circle cx="3.5" cy="11.5" r="1.5" />
      <circle cx="12.5" cy="11.5" r="1.5" />
      <circle cx="8" cy="3.5" r="1.5" />
      <path d="M4.6 10.2 7 5" />
      <path d="M11.4 10.2 9 5" />
      <path d="M5 11.5 11 11.5" />
    </svg>
  );
}

export function ChevronIcon(props: IconProps & { open?: boolean }) {
  const { open, ...rest } = props;
  return (
    <svg
      {...base(rest)}
      style={{
        ...rest.style,
        transform: open ? "rotate(90deg)" : "rotate(0deg)",
        transition: "transform var(--motion-instant) var(--ease-out-quart)",
      }}
    >
      <path d="M6 4 L10 8 L6 12" />
    </svg>
  );
}
