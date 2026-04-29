import { useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { fileKind } from "@/lib/fileKind";

interface Props {
  /** Absolute path to the file on disk. */
  path: string;
}

/**
 * Editor stand-in for files we can't safely render as text — images
 * preview directly, everything else gets a small info card.
 *
 * Images load through Tauri's `asset://` protocol (configured in
 * tauri.conf.json: `assetProtocol.enable = true`, scope `**`), so the
 * webview reads them straight from disk without us shipping bytes
 * through IPC. That keeps a 4 MB icon preview cheap.
 */
export function BinaryView({ path }: Props) {
  const kind = fileKind(path);
  const filename = path.split("/").pop() || path;

  if (kind === "image") return <ImagePreview path={path} filename={filename} />;
  return <BinaryInfo path={path} filename={filename} />;
}

function ImagePreview({ path, filename }: { path: string; filename: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    try {
      setSrc(convertFileSrc(path));
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, [path]);

  return (
    <div
      style={{
        height: "100%",
        width: "100%",
        display: "flex",
        flexDirection: "column",
        backgroundColor: "var(--surface-0)",
      }}
    >
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: "grid",
          placeItems: "center",
          padding: "var(--space-4)",
          // Subtle checkerboard so transparent PNGs don't disappear
          // into the dark surface — same trick Preview.app uses.
          backgroundImage:
            "linear-gradient(45deg, var(--surface-1) 25%, transparent 25%), linear-gradient(-45deg, var(--surface-1) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, var(--surface-1) 75%), linear-gradient(-45deg, transparent 75%, var(--surface-1) 75%)",
          backgroundSize: "16px 16px",
          backgroundPosition: "0 0, 0 8px, 8px -8px, -8px 0px",
        }}
      >
        {error ? (
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-xs)",
              color: "var(--state-error-bright)",
            }}
          >
            {error}
          </span>
        ) : (
          src && (
            <img
              src={src}
              alt={filename}
              onLoad={(e) =>
                setNaturalSize({
                  w: (e.target as HTMLImageElement).naturalWidth,
                  h: (e.target as HTMLImageElement).naturalHeight,
                })
              }
              onError={() => setError("could not load image")}
              style={{
                maxWidth: "100%",
                maxHeight: "100%",
                objectFit: "contain",
                imageRendering: "auto",
                boxShadow: "var(--shadow-popover)",
              }}
            />
          )
        )}
      </div>
      <FooterStrip
        items={[
          filename,
          naturalSize ? `${naturalSize.w} × ${naturalSize.h}` : null,
        ]}
      />
    </div>
  );
}

function BinaryInfo({ path, filename }: { path: string; filename: string }) {
  return (
    <div
      style={{
        height: "100%",
        width: "100%",
        display: "flex",
        flexDirection: "column",
        backgroundColor: "var(--surface-0)",
      }}
    >
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: "grid",
          placeItems: "center",
          padding: "var(--space-4)",
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: "var(--space-2)",
            color: "var(--text-tertiary)",
            textAlign: "center",
          }}
        >
          <div
            aria-hidden
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-3xl)",
              lineHeight: 1,
              opacity: 0.4,
            }}
          >
            ⛶
          </div>
          <div
            style={{
              fontFamily: "var(--font-sans)",
              fontSize: "var(--text-sm)",
              fontWeight: "var(--weight-medium)",
              color: "var(--text-secondary)",
            }}
          >
            {filename}
          </div>
          <div
            style={{
              fontFamily: "var(--font-sans)",
              fontSize: "var(--text-2xs)",
              color: "var(--text-tertiary)",
            }}
          >
            Binary file — preview not supported
          </div>
        </div>
      </div>
      <FooterStrip items={[path]} />
    </div>
  );
}

function FooterStrip({ items }: { items: (string | null)[] }) {
  const filtered = items.filter((x): x is string => !!x);
  if (filtered.length === 0) return null;
  return (
    <div
      style={{
        height: 24,
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        gap: "var(--space-3)",
        padding: "0 var(--space-3)",
        borderTop: "var(--border-1)",
        backgroundColor: "var(--surface-1)",
        fontFamily: "var(--font-mono)",
        fontSize: "var(--text-2xs)",
        color: "var(--text-tertiary)",
        userSelect: "none",
        whiteSpace: "nowrap",
        overflow: "hidden",
      }}
    >
      {filtered.map((it, i) => (
        <span
          key={i}
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {it}
        </span>
      ))}
    </div>
  );
}
