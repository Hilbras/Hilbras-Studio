/**
 * Inngest's HTTP entry point (ADR-001).
 *
 * Inngest calls this route to deliver events, resume suspended functions, and
 * report step results. It is authenticated by Inngest itself — the serving key
 * is verified inside `serve()` — so there is no session or same-origin check to
 * add here, and adding one would break Inngest's callbacks.
 *
 * Every invocation is signed, and a request that fails the signature check is
 * rejected inside the SDK before it reaches any function. Nothing in this route
 * reads the session cookie, because the functions establish identity from the
 * event payload's userId, which is written by the scheduler.
 */

import { serve } from "inngest/next";

import { inngest } from "@/lib/runtime/inngest/client";
import { inngestFunctions } from "@/lib/runtime/inngest/functions";

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: inngestFunctions,
});
