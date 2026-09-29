import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { exportUserData } from "@/lib/account-lifecycle";

/**
 * Self-serve account data export (remediation Task 8).
 *
 * One JSON document containing everything the user's id reaches, with secret
 * material reduced to presence flags (see `exportUserData`). Authenticated
 * like every account route: the session is the only scoping input, so an
 * export is always exactly the caller's own data.
 */
export async function GET(_req: NextRequest) {
  const session = await getSessionUser();
  if (!session) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const data = await exportUserData(session.id);
  const filename = `hilbras-studio-export-${new Date().toISOString().slice(0, 10)}.json`;

  return new NextResponse(JSON.stringify(data, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
