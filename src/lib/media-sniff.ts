/**
 * Magic-byte sniffing for image uploads.
 *
 * The browser-declared MIME type is attacker-controlled; the leading bytes
 * are not. Returns the type implied by the content, or null when the bytes
 * don't match any supported format.
 */
export function sniffImageMime(bytes: Buffer): string | null {
  // JPEG: FF D8 FF
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  // GIF: "GIF8" covers both GIF87a and GIF89a
  if (bytes.length >= 4 && bytes.toString("ascii", 0, 4) === "GIF8") {
    return "image/gif";
  }
  // WebP: "RIFF" .... "WEBP"
  if (
    bytes.length >= 12 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}
