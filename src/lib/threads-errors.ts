/**
 * The Threads API permission gate.
 *
 * When a Threads app user's grant carries no permission at all, **every** Threads
 * endpoint (including `GET /me`) answers:
 *
 *   400 {"type":"THApiException","code":100,"error_subcode":10,
 *        "message":"This action requires the threads_basic permission.
 *                   You must submit for app review, or your user must be in
 *                   the list of Threads testers."}
 *
 * Meta still issues an access token during the authorization window in that case,
 * so the connection looks healthy and the failure only appears on the first API
 * call — in practice the first publish. Meta's rule (Get Started → *Threads
 * testers*) is that permissions can only be granted by an app user **with a role
 * on the app** until the app is published *and* each permission passed App
 * Review: so the account is either not an accepted Threads Tester, or the app is
 * published but the permissions were never approved.
 *
 * Deliberately free of `server-only` and of any Node API, so the client component
 * that renders connect errors can import the wording instead of duplicating it.
 */

/** Meta's codes for "this app user granted no permission". */
const THREADS_PERMISSION_CODE = 100;
const THREADS_PERMISSION_SUBCODE = 10;

/** The part of Meta's message that is stable across the affected endpoints. */
const THREADS_PERMISSION_MESSAGE = "requires the threads_basic permission";

/**
 * Short label for the Accounts card, where the long sentence below does not fit.
 *
 * Shown instead of "Connected": a stored token without a grant is the state that
 * looks healthy and cannot publish.
 */
export const THREADS_PERMISSION_BADGE = "No permissions — reconnect";

/**
 * What the user has to do, in one sentence — shared by the connect error banner,
 * the publish result and the Accounts reconnect prompt so all three say the same
 * thing.
 *
 * Both halves are required: adding the role in the dashboard is not enough on its
 * own (Meta: "you must first send an invitation to the Threads user's profile
 * **and accept the invitation**"), and the token issued before the invite was
 * accepted stays empty forever. That last part is what makes the *reconnect* step
 * mandatory rather than cosmetic — a grant belongs to the token it was issued
 * for.
 */
export const THREADS_PERMISSION_FIX =
  "Meta granted this Threads connection no permissions (Threads API error 100/10). " +
  "Add the account as a Threads Tester in the app dashboard (App roles → Roles → Add People), " +
  "accept the invitation at threads.net → Settings → Account → Website permissions, " +
  "then reconnect Threads from Settings → Accounts → Threads → Config → Reconnect via OAuth.";

/** Shape of Meta's error envelope — only the fields we classify by. */
interface MetaErrorEnvelope {
  error?: {
    message?: unknown;
    code?: unknown;
    error_subcode?: unknown;
  };
}

/**
 * True for Meta's "app user has no grant" answer.
 *
 * The numeric pair is checked first because it survives Meta's wording changes;
 * the message is the fallback for payloads where `error_subcode` is missing.
 */
export function isThreadsPermissionError(payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null) return false;

  const { message, code, error_subcode } = (payload as MetaErrorEnvelope).error ?? {};

  if (code === THREADS_PERMISSION_CODE && error_subcode === THREADS_PERMISSION_SUBCODE) {
    return true;
  }

  return typeof message === "string" && message.includes(THREADS_PERMISSION_MESSAGE);
}