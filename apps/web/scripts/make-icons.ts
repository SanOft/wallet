import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { crc32, deflateSync } from "node:zlib"

/**
 * Generates the PWA icon set from the mark already in `index.html`.
 *
 * Committed as a script, not only as four PNGs, because a binary asset with no
 * provenance is one nobody dares change: the next person needs a different
 * size, cannot reproduce the existing ones, and either guesses in an image
 * editor or ships something that does not match. Here the mark is code, the
 * sizes are a list, and regenerating is one command.
 *
 * No dependency. A PNG is a signature, three chunks and a CRC, and `zlib` is
 * in Node — the alternative was `sharp`, which is a native binary and a
 * postinstall step for four static files that change approximately never.
 *
 * The mark is the placeholder wallet outline from `index.html`, in the
 * placeholder brand blue §13.2.2 already flags as provisional. When the real
 * brand arrives, this file changes and the set regenerates.
 */

/** The placeholder brand blue, per channel. White needs no constant: it is 255. */
const BRAND = [0x17, 0x5c, 0xd3] as const

/** The design is authored in the same 32×32 space as the inline favicon. */
const UNITS = 32

/** 4×4 samples per pixel. Enough anti-aliasing at 192px to look drawn, not stepped. */
const SAMPLES = 4

interface Shape {
  /** Is this point, in design units, inside the shape? */
  covers(x: number, y: number): boolean
}

function roundedSquare(size: number, radius: number): Shape {
  return {
    covers(x, y) {
      const dx = Math.max(radius - x, x - (size - radius), 0)
      const dy = Math.max(radius - y, y - (size - radius), 0)
      return dx * dx + dy * dy <= radius * radius
    },
  }
}

function rect(x0: number, y0: number, x1: number, y1: number): Shape {
  return { covers: (x, y) => x >= x0 && x <= x1 && y >= y0 && y <= y1 }
}

function circle(cx: number, cy: number, r: number): Shape {
  return { covers: (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r }
}

/** The wallet outline: a stroked rectangle and the clasp, as in index.html. */
function mark(): { readonly inside: Shape; readonly hole: Shape; readonly clasp: Shape } {
  const stroke = 2.5
  return {
    inside: rect(7, 11, 25, 23),
    hole: rect(7 + stroke, 11 + stroke, 25 - stroke, 23 - stroke),
    clasp: circle(21, 17, 2),
  }
}

/**
 * The background always fills the whole canvas; only the *mark* shrinks.
 *
 * Scaling both is the mistake this comment exists to prevent, and it was made
 * here first: a maskable icon with transparent margins comes back from the
 * platform's crop with holes in it, because the OS assumes it may cut anywhere
 * outside the central circle and finds nothing underneath.
 *
 * @param size pixels
 * @param markScale how much of the design the mark occupies. Below 1 for
 *   maskable icons, which keep their content inside the safe central circle.
 * @param rounded false for maskable: the OS applies its own mask, and baking
 *   corners in leaves a visible double-rounded silhouette.
 */
function render(size: number, markScale: number, rounded: boolean): Buffer {
  const shapes = mark()
  const background = roundedSquare(UNITS, rounded ? 7 : 0)

  const pixels = Buffer.alloc(size * size * 4)
  const centre = UNITS / 2

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let bg = 0
      let fg = 0

      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          // Sample at pixel centres of the subgrid, then map back into design
          // units, undoing the inset the scale introduced.
          const cx = (px + (sx + 0.5) / SAMPLES) / size
          const cy = (py + (sy + 0.5) / SAMPLES) / size
          const ux = cx * UNITS
          const uy = cy * UNITS

          if (!background.covers(ux, uy)) continue
          bg++

          // The mark is measured in its own scaled space, about the centre.
          const mx = (ux - centre) / markScale + centre
          const my = (uy - centre) / markScale + centre

          const onStroke = shapes.inside.covers(mx, my) && !shapes.hole.covers(mx, my)
          if (onStroke || shapes.clasp.covers(mx, my)) fg++
        }
      }

      const total = SAMPLES * SAMPLES
      const alpha = bg / total
      const white = fg / total

      const offset = (py * size + px) * 4

      /*
       * The mark is composited over the brand colour rather than blended with
       * transparency, so a white edge pixel does not go grey against a dark
       * platform background.
       *
       * `forEach` rather than an index loop: `BRAND[channel]` is
       * `number | undefined` to the type checker, and the assertion that
       * silenced it was asserting something worth not asserting in a file that
       * writes raw bytes.
       */
      const markShare = white / Math.max(alpha, 1e-6)
      BRAND.forEach((brand, channel) => {
        const value = brand * (1 - markShare) + 255 * markShare
        pixels[offset + channel] = Math.round(Math.min(255, Math.max(0, value)))
      })
      pixels[offset + 3] = Math.round(alpha * 255)
    }
  }

  return encodePng(size, size, pixels)
}

function chunk(type: string, body: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(body.length)

  const typed = Buffer.concat([Buffer.from(type, "ascii"), body])
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(typed) >>> 0)

  return Buffer.concat([length, typed, checksum])
}

function encodePng(width: number, height: number, rgba: Buffer): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // bit depth
  header[9] = 6 // truecolour with alpha
  header[10] = 0 // deflate
  header[11] = 0 // adaptive filtering
  header[12] = 0 // no interlace

  // Every scanline is prefixed with its filter type. Zero — "none" — because
  // these are flat-colour images where predictive filters buy almost nothing
  // and cost the reader an explanation.
  const raw = Buffer.alloc(height * (1 + width * 4))
  for (let y = 0; y < height; y++) {
    const from = y * width * 4
    rgba.copy(raw, y * (1 + width * 4) + 1, from, from + width * 4)
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ])
}

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "public")
mkdirSync(out, { recursive: true })

const icons = [
  { file: "icon-192.png", size: 192, markScale: 1, rounded: true },
  { file: "icon-512.png", size: 512, markScale: 1, rounded: true },
  // 0.7 keeps the mark inside the safe circle a maskable icon is cropped to,
  // while the background still reaches every edge.
  { file: "icon-maskable-512.png", size: 512, markScale: 0.7, rounded: false },
  // iOS does not read the manifest for this one and does not round it either.
  { file: "apple-touch-icon.png", size: 180, markScale: 1, rounded: true },
] as const

for (const icon of icons) {
  const png = render(icon.size, icon.markScale, icon.rounded)
  writeFileSync(join(out, icon.file), png)
  console.log(`  ${icon.file.padEnd(28)} ${icon.size}×${icon.size}  ${png.length} bytes`)
}
