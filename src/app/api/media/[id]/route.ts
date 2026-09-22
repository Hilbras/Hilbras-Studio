import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";

/**
 * Serves uploaded media by id. Deliberately **unauthenticated**: Meta's
 * publish endpoints fetch this URL server-side with no session cookie. The id
 * is a random UUID, so possession of the URL is the capability — same model as
 * every other unguessable public asset URL.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  let row:
    | { mimeType: string; data: Buffer }
    | undefined;
  try {
    [row] = await db
      .select({ mimeType: schema.mediaAssets.mimeType, data: schema.mediaAssets.data })
      .from(schema.mediaAssets)
      .where(eq(schema.mediaAssets.id, id))
      .limit(1);
  } catch (e) {
    console.error("media read failed", e);
    return new NextResponse("Storage error", { status: 500 });
  }

  if (!row) return new NextResponse("Not found", { status: 404 });

  return new NextResponse(new Uint8Array(row.data), {
    headers: {
      "Content-Type": row.mimeType,
      // Uploads are immutable — a new upload is a new id.
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}
