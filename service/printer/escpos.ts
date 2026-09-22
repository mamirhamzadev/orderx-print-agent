import { PNG } from "pngjs";
import { getActivePrinter, sendRawToPrinter } from "./connection";
import { loadConfig, type PaperWidth } from "./configStore";

const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;

const CHUNK_MAX_HEIGHT = 512;

export type PrintOptions = {
  paperWidth?: PaperWidth;
};

/**
 * Converts a base64 PNG image into 1-bit monochrome raster bitmask
 * and transmits it to the active printer via ESC/POS GS v 0.
 * Automatically centers the receipt along the x-axis if the image
 * is narrower than the printer's physical paper roll (e.g. 58mm/48mm on 80mm roll).
 */
export async function printPngBase64(
  imageBase64: string,
  options?: PrintOptions,
): Promise<void> {
  const printer = getActivePrinter();
  if (!printer?.ip) {
    throw new Error("No thermal printer is currently connected");
  }

  const cleanBase64 = imageBase64.replace(/^data:image\/png;base64,/, "").trim();
  const buffer = Buffer.from(cleanBase64, "base64");
  const png = PNG.sync.read(buffer);

  const srcWidth = png.width;
  const srcHeight = png.height;
  if (!srcWidth || !srcHeight) {
    throw new Error("Invalid PNG image dimensions");
  }

  // 1. Resolve physical printer roll width:
  // Standard POS thermal printers use 80mm paper (576 printable dots / 72 bytes per line).
  // If physically configured as 58mm, roll width is 384 dots (48 bytes per line).
  const savedConfig = loadConfig();
  const physicalWidth: PaperWidth =
    savedConfig.paperWidth === "58mm" ? "58mm" : "80mm";
  const printerWidthDots = physicalWidth === "80mm" ? 576 : 384;
  const widthBytes = Math.floor(printerWidthDots / 8);

  // 2. Resolve content width & scaling:
  // If srcWidth >= 500: image was rendered for 80mm (576px or 2x 1152px)
  // If srcWidth < 500: image was rendered for 58mm / compact (384px or 2x 768px)
  let targetContentDots: number;
  if (srcWidth >= 500) {
    targetContentDots = 576;
  } else {
    targetContentDots = 384;
  }

  const scale = srcWidth > targetContentDots ? srcWidth / targetContentDots : 1.0;
  const contentWidthDots = Math.min(
    printerWidthDots,
    Math.round(srcWidth / scale),
  );
  const targetHeightDots = Math.max(1, Math.round(srcHeight / scale));

  // 3. Horizontal centering calculation:
  // If content is narrower than the physical roll (e.g. 384 dots on an 80mm / 576-dot roll):
  // Center it with equal left and right margins!
  const xOffsetDots = Math.max(
    0,
    Math.floor((printerWidthDots - contentWidthDots) / 2),
  );

  // Build 1-bit raster bitmask spanning the full physical roll width
  const rasterBuffer = Buffer.alloc(widthBytes * targetHeightDots, 0);

  for (let y = 0; y < targetHeightDots; y++) {
    const srcY = Math.min(srcHeight - 1, Math.floor(y * scale));
    const rowOffset = y * widthBytes;

    for (let cx = 0; cx < contentWidthDots; cx++) {
      const srcX = Math.min(srcWidth - 1, Math.floor(cx * scale));
      const pixelIdx = (srcY * srcWidth + srcX) * 4;

      const r = png.data[pixelIdx];
      const g = png.data[pixelIdx + 1];
      const b = png.data[pixelIdx + 2];
      const a = png.data[pixelIdx + 3];

      // Treat transparent or semi-transparent as white
      // Compute standard perceptual luminance
      const isBlack = a >= 128 && 0.299 * r + 0.587 * g + 0.114 * b < 185;

      if (isBlack) {
        const destX = xOffsetDots + cx;
        if (destX < printerWidthDots) {
          const byteIndex = rowOffset + Math.floor(destX / 8);
          const bitOffset = 7 - (destX % 8);
          rasterBuffer[byteIndex] |= 1 << bitOffset;
        }
      }
    }
  }

  // Construct ESC/POS print stream
  const chunks: Buffer[] = [];

  // 1. Initialize printer: ESC @
  chunks.push(Buffer.from([ESC, 0x40]));

  // 2. Left alignment (ESC a 0) so the pre-centered raster spans from dot 0
  chunks.push(Buffer.from([ESC, 0x61, 0x00]));

  // 3. Output raster in chunks of CHUNK_MAX_HEIGHT dots to avoid printer buffer overflow
  let yOffset = 0;
  while (yOffset < targetHeightDots) {
    const chunkHeight = Math.min(CHUNK_MAX_HEIGHT, targetHeightDots - yOffset);
    const chunkByteLength = chunkHeight * widthBytes;
    const chunkData = rasterBuffer.subarray(
      yOffset * widthBytes,
      yOffset * widthBytes + chunkByteLength,
    );

    // GS v 0 m xL xH yL yH
    const header = Buffer.from([
      GS,
      0x76,
      0x30,
      0x00, // Mode 0 = Normal
      widthBytes & 0xff,
      (widthBytes >> 8) & 0xff,
      chunkHeight & 0xff,
      (chunkHeight >> 8) & 0xff,
    ]);

    chunks.push(header);
    chunks.push(chunkData);

    yOffset += chunkHeight;
  }

  // 4. Feed 1 line + Partial Cut: GS V 66 0
  chunks.push(Buffer.from([LF, GS, 0x56, 0x42, 0x00]));

  const payload = Buffer.concat(chunks);
  await sendRawToPrinter(payload, printer.ip, printer.port);
}
