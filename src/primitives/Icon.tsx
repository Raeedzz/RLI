import type { SVGProps, CSSProperties } from "react";
import {
  Folder01Icon,
  Search01Icon,
  FlowIcon,
  ComputerIcon,
  GitBranchIcon,
  Settings01Icon,
  ComputerTerminal01Icon,
  DocumentCodeIcon,
  BrainIcon,
  ArrowRight01Icon,
} from "hugeicons-react";

/**
 * Legacy named icons retained for callers across the app. Underneath
 * they render via `hugeicons-react` (stroke-rounded set, currentColor).
 *
 * All icons inherit color from the parent (`currentColor`), so theme
 * tokens flow naturally. Callers continue to pass `size` (px) and any
 * standard SVG props.
 */

type IconProps = Omit<SVGProps<SVGSVGElement>, "strokeWidth"> & {
  size?: number;
  strokeWidth?: number;
};

function commonProps(p: IconProps) {
  const { size = 16, strokeWidth, ...rest } = p;
  return {
    size,
    color: "currentColor",
    strokeWidth: strokeWidth ?? 1.5,
    ...rest,
  };
}

export function FolderIcon(props: IconProps) {
  return <Folder01Icon {...commonProps(props)} />;
}

export function SearchIcon(props: IconProps) {
  return <Search01Icon {...commonProps(props)} />;
}

export function ConnectionsIcon(props: IconProps) {
  return <FlowIcon {...commonProps(props)} />;
}

export function BrowserIcon(props: IconProps) {
  return <ComputerIcon {...commonProps(props)} />;
}

export function GitIcon(props: IconProps) {
  return <GitBranchIcon {...commonProps(props)} />;
}

export function SettingsIcon(props: IconProps) {
  return <Settings01Icon {...commonProps(props)} />;
}

export function TerminalIcon(props: IconProps) {
  return <ComputerTerminal01Icon {...commonProps(props)} />;
}

export function FileIcon(props: IconProps) {
  return <DocumentCodeIcon {...commonProps(props)} />;
}

export function GraphIcon(props: IconProps) {
  return <BrainIcon {...commonProps(props)} />;
}

export function ChevronIcon(props: IconProps & { open?: boolean }) {
  const { open, style, ...rest } = props;
  const merged: CSSProperties = {
    ...style,
    transform: open ? "rotate(90deg)" : "rotate(0deg)",
    transition: "transform var(--motion-instant) var(--ease-out-quart)",
  };
  return <ArrowRight01Icon {...commonProps(rest)} style={merged} />;
}
