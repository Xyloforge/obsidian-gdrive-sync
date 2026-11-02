/**
 * Shrinks large phone photos in place: long side to MAX_SIDE px, re-encoded in the
 * same lossy format so the file name and links stay valid. Also applies the EXIF
 * rotation and drops metadata (including GPS location).
 */

export const MAX_SIDE = 1600;
export const MIN_BYTES = 500_000;
const QUALITY = 0.8;

const LOSSY: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" };

function extOf(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot < 0 ? "" : path.slice(dot + 1).toLowerCase();
}

export function shouldCompress(path: string, bytes: number): boolean {
  if (path.startsWith(".")) return false;
  return extOf(path) in LOSSY && bytes > MIN_BYTES;
}

export function fitWithin(width: number, height: number, max: number): { width: number; height: number } {
  const scale = Math.min(1, max / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** Returns smaller bytes, or null when compression would not help. Browser/WebView only. */
export async function compressImage(path: string, data: ArrayBuffer): Promise<ArrayBuffer | null> {
  const mime = LOSSY[extOf(path)];
  if (!mime) return null;
  const bitmap = await createImageBitmap(new Blob([data], { type: mime }), { imageOrientation: "from-image" });
  try {
    const size = fitWithin(bitmap.width, bitmap.height, MAX_SIDE);
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, size.width, size.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mime, QUALITY));
    if (!blob) return null;
    const out = await blob.arrayBuffer();
    return out.byteLength < data.byteLength ? out : null;
  } finally {
    bitmap.close();
  }
}
