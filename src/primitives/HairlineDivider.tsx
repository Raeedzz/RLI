interface Props {
  orientation?: "horizontal" | "vertical";
  inset?: number;
}

export function HairlineDivider({
  orientation = "horizontal",
  inset = 0,
}: Props) {
  const isH = orientation === "horizontal";
  return (
    <div
      style={{
        flexShrink: 0,
        backgroundColor: "var(--border-hairline)",
        width: isH ? "auto" : 1,
        height: isH ? 1 : "auto",
        marginInline: isH ? inset : 0,
        marginBlock: isH ? 0 : inset,
      }}
    />
  );
}
