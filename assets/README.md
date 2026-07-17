# Brand assets

Current brand: the **phoenix mark** (source: an AI-generated render on a baked-in
checkerboard; background removed via chroma key + edge un-blending —
`png/logo1-transparent.png` is the master).

- `logo1-transparent.svg` — phoenix mark alone (embedded PNG, transparent).
- `logo1-lettering.svg` — horizontal lockup: mark + `fast-firebird` wordmark.
- `logo2-lettering.svg` — lockup + tagline "The modern, pure-TypeScript Firebird
  driver for Node.js" (README banner).
- `png/logo1-transparent.png` — mark, 1040×1083, transparent.
- `png/logo1-lettering.png` — lockup, 3467×1083.
- `png/logo2-lettering.png` — lockup + tagline, 5073×1083.
- `png/logo2-lettering-1440.png` — 1440-wide export (npm package READMEs, social cards).

The SVGs embed the raster mark as base64 (the artwork is gradient raster, not
vector paths) with the wordmark/tagline as real SVG text, `textLength`-locked so
layout is stable across font stacks. Wordmark style: `fast-` `#C0562A`,
`firebird` gradient `#FF6A2C → #FFB13C`, weight 800; tagline monospace `#8b99a8`.

## Previous kit (kept)

- `logo.svg` — original horizontal wordmark lockup (drawn flame mark).
- `mark.svg` — original firebird mark alone.
- `favicon.ico` — multi-size icon from the original mark.
- `png/mark-*.png`, `png/logo-1440x300.png` — rasters of the original kit.

The demo app's favicon set (`apps/demo/web/public/`) is generated from the
phoenix mark: square-canvas crops at 256 (`mark.svg`, `favicon.ico` 16/32/48)
and 180 (`mark-180.png`).
