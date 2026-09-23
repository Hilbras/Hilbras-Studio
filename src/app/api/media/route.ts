import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { getSessionUser } from "@/lib/session";
import { sniffImageMime } from "@/lib/media-sniff";
import { db, schema } from "@/db";
import { requestOrigin } from "@/lib/request-origin";

/**
 * Upload an image and get back a public URL for the Composer's media field.
 *
 * Stored in Postgres behind /api/media/[id] rather than a file service so the
 * app needs no extra credentials; Vercel's ~4.5 MB request/response ceiling
 * bounds the size either way, hence the 4 MB cap.
 */
const MAX_BYTES = 4 * 1024 * 1024;
const ALLOWED_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

export async function POST(req: NextRequest) {
  const session = await getSessionUser();
  if (!session) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  let file: File;
  try {
    const form = await req.formData();
    const candidate = form.get("file");
    if (!(candidate instanceof File)) throw new Error("missing file");
    file = candidate;
  } catch {
    return NextResponse.json(
      { error: "Send an image in the `file` field." },
      { status: 400 }
    );
  }

  if (!ALLOWED_TYPES.has(file.type)) {
    return NextResponse.json(
      { error: "Only JPEG, PNG, WebP or GIF images can be uploaded." },
      { status: 400 }
    );
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: "Image is over 4 MB — compress it or use a media URL instead." },
      { status: 413 }
    );
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  if (bytes.byteLength === 0) {
    return NextResponse.json({ error: "The file is empty." }, { status: 400 });
  }

  // The declared MIME type is client-supplied — trust the actual bytes.
  const sniffed = sniffImageMime(bytes);
  if (!sniffed || sniffed !== file.type) {
    return NextResponse.json(
      { error: "The file's content does not match a supported image type." },
      { status: 400 }
    );
  }

  const id = randomUUID();
  try {
    await db.insert(schema.mediaAssets).values({
      id,
      userId: session.id,
      filename: file.name.slice(0, 255) || "upload",
      mimeType: file.type,
      sizeBytes: bytes.byteLength,
      data: bytes,
    });
  } catch (e) {
    console.error("media upload failed", e);
    return NextResponse.json(
      { error: "Could not store the image — try again." },
      { status: 500 }
    );
  }

  // Absolute and canonical (APP_URL): Meta fetches this URL from outside the
  // app, so a localhost origin from a dev-session upload would be useless.
  return NextResponse.json({ url: `${requestOrigin(req)}/api/media/${id}` });
}
