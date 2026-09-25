import dragonMark from "./dragon-mark.png";

// `color` is kept in the signature for source compatibility with existing
// callers (TopBar, Toolbar, WorkspaceView overview, AboutSection) but has no
// effect — unlike the previous abstract SVG mark, this is a fixed-color
// raster image and can't recolor with the theme via `currentColor`/`fill`.
export function Mark({ size = 16, className }: { size?: number; color?: string; className?: string }) {
  return (
    <img
      src={dragonMark}
      width={size}
      height={size}
      alt=""
      className={className}
      style={{ objectFit: "contain" }}
    />
  );
}
