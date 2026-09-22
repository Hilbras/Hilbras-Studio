"use client";

import { motion, AnimatePresence } from "framer-motion";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, useCallback } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PlatformIcon } from "@/components/platform-icon";
import { GradientMesh } from "@/components/motion/gradient-mesh";
import { WordReveal } from "@/components/motion/word-reveal";
import { BlurFade } from "@/components/motion/blur-fade";
import { MagneticButton } from "@/components/motion/magnetic-button";
import { StaggerChildren, staggerItem } from "@/components/motion/stagger-children";
import {
  CheckCircle2,
  XCircle,
  Settings,
  Loader2,
  TestTube2,
  Link2,
  Unlink,
  RefreshCw,
  AlertTriangle,
  Copy,
  Check,
} from "lucide-react";
import { allPlatforms, type PlatformId } from "@/lib/platforms";
import { THREADS_PERMISSION_BADGE, THREADS_PERMISSION_FIX } from "@/lib/threads-errors";
import { TOKEN_EXPIRED_BADGE, TOKEN_EXPIRED_FIX } from "@/lib/platform-tokens";
import {
  getPlatformCredentials,
  savePlatformCredentials,
  testPlatformCredentials,
  checkCredentialsExist,
  disconnectPlatform,
  getConnectRedirectUri,
} from "@/app/actions/platform";
import { connectTelegramAction } from "@/app/actions/telegram";

type TestResult = { valid: boolean; message: string };

/**
 * Connect failures come back as `?error=<code>`. The codes we raise ourselves get
 * a sentence explaining what to do; provider codes (`<name>_<reason>`) are shown
 * as they are, because only the provider knows what they mean.
 *
 * The wording for `threads_app_id_invalid` mirrors `THREADS_APP_ID_HINT` in
 * `@/lib/platform-app-check`. It is repeated rather than imported because that
 * module is `server-only` and this page is a client component. The Threads
 * permissions wording *is* imported — `@/lib/threads-errors` is deliberately
 * isomorphic, so the connect banner and the publish result cannot drift apart.
 */
const CONNECT_ERROR_MESSAGES: Record<string, string> = {
  credentials_not_configured:
    "No app credentials are saved for this platform yet. Open Configure, paste the client ID and secret, then connect.",
  threads_permissions_not_granted: THREADS_PERMISSION_FIX,
  threads_app_id_invalid:
    "That app ID is not a Threads app ID. A Meta app hands out two pairs — paste the Threads app ID and secret from the app's Threads use case (Settings → Threads), not the Instagram/Facebook pair.",
  credentials_missing:
    "The saved app credentials could not be read. Save them again in Configure.",
  invalid_state:
    "The authorization was started in a different browser session. Start the connect again from this page.",
  missing_pkce_verifier:
    "The browser dropped the PKCE cookie mid-flow. Start the connect again from this page.",
  missing_code_or_state:
    "The provider sent the browser back without an authorization code. Start the connect again from this page.",
  no_access_token:
    "The provider returned no access token — usually an app ID/secret mismatch, or a redirect URI that is not registered exactly.",
  url_blocked:
    "The provider blocked the redirect URL (Meta error 1349168). Register the redirect URI shown in Configure — exactly as printed, with no trailing slash added — as a valid OAuth redirect URI in the app's Client OAuth Settings.",
  access_denied:
    "You cancelled the authorization window, so nothing was connected. Start the connect again whenever you are ready.",
  instagram_personal_only:
    "Instagram publishing needs a Business or Creator account, not a personal profile.",
  manual_connection:
    "This platform does not use OAuth — open its Config on the Accounts page and connect with the form there.",
};

function safeDecode(value: string): string {
  // `useSearchParams` already decodes; a second pass can throw on a stray "%".
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function describeConnectError(raw: string): string {
  if (CONNECT_ERROR_MESSAGES[raw]) return CONNECT_ERROR_MESSAGES[raw];
  // Meta sometimes forwards the numeric code instead of a slug.
  if (raw === "1349168") return CONNECT_ERROR_MESSAGES.url_blocked;
  if (raw.endsWith("_app_credentials_invalid")) {
    return "The provider rejected these app credentials. Re-copy the client ID and secret for this platform.";
  }
  if (raw.startsWith("token_exchange_failed")) {
    const status = raw.split(":")[1];
    return `The token exchange failed${status ? ` (HTTP ${status})` : ""} — the app ID/secret or the registered redirect URI does not match this platform.`;
  }
  return raw;
}

export default function AccountsPage() {
  const searchParams = useSearchParams();
  const connectedPlatform = searchParams.get("connected");
  const errorParam = searchParams.get("error");
  const [showFeedback, setShowFeedback] = useState(false);

  const [configured, setConfigured] = useState<Set<string>>(new Set());
  const [connected, setConnected] = useState<Set<string>>(new Set());
  // Platforms whose stored token provably carries no permission grant. They are
  // "connected" in the database and useless against the API, so the card must not
  // show a green badge and the modal must offer a reconnect.
  const [permissionsMissing, setPermissionsMissing] = useState<Set<string>>(new Set());
  // Platforms whose stored session has expired. Same reasoning, different cause:
  // Meta only refreshes a token while it is valid, so these can only be fixed by
  // a fresh authorization — which is exactly what the reconnect button starts.
  const [expired, setExpired] = useState<Set<string>>(new Set());

  const [modalOpen, setModalOpen] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [selectedPlatform, setSelectedPlatform] = useState<string>("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [loadingKeys, setLoadingKeys] = useState(false);
  const [saving, setSaving] = useState(false);
  const [modalError, setModalError] = useState("");
  const [modalSuccess, setModalSuccess] = useState("");
  const [redirectUri, setRedirectUri] = useState<string | null>(null);
  const [copiedUri, setCopiedUri] = useState(false);

  // Telegram connects manually: the bot token and chat pasted into the modal.
  const [tgToken, setTgToken] = useState("");
  const [tgChat, setTgChat] = useState("");
  const [tgConnecting, setTgConnecting] = useState(false);

  const [testResults, setTestResults] = useState<Record<string, TestResult>>({});
  const [testingPlatform, setTestingPlatform] = useState<string | null>(null);

  const paramsHandledRef = useRef(false);

  const refreshData = useCallback(async () => {
    const platforms = allPlatforms();
    const [confResults, connResults] = await Promise.all([
      Promise.all(platforms.map(async (p) => ({ id: p.id, exists: await checkCredentialsExist(p.id) }))),
      (async () => {
        try {
          const res = await fetch("/api/check-connections");
          if (res.ok) {
            return await res.json() as {
              connected: string[];
              permissionsMissing?: string[];
              expired?: string[];
            };
          }
        } catch {}
        return {
          connected: [] as string[],
          permissionsMissing: [] as string[],
          expired: [] as string[],
        };
      })(),
    ]);
    setConfigured(new Set(confResults.filter((r) => r.exists).map((r) => r.id)));
    setConnected(new Set(connResults.connected));
    // Absent fields (an older response shape) read as "nothing known to be
    // broken" rather than as an error.
    setPermissionsMissing(new Set(connResults.permissionsMissing ?? []));
    setExpired(new Set(connResults.expired ?? []));
  }, []);

  useEffect(() => { refreshData(); }, [refreshData]);

  useEffect(() => {
    if ((connectedPlatform || errorParam) && !paramsHandledRef.current) {
      paramsHandledRef.current = true;
      setShowFeedback(true);
      refreshData();
      const t = setTimeout(() => setShowFeedback(false), 5000);
      return () => clearTimeout(t);
    }
  }, [connectedPlatform, errorParam, refreshData]);

  const openModal = async (platform: string) => {
    setSelectedPlatform(platform);
    setClientId("");
    setClientSecret("");
    setTgToken("");
    setTgChat("");
    setModalError("");
    setModalSuccess("");
    setModalOpen(true);
    // Manual platforms (Telegram) have no app credentials or redirect URI to
    // load — their form *is* the connection.
    if (allPlatforms().some((p) => p.id === platform && p.connection === "manual")) {
      return;
    }
    setLoadingKeys(true);
    try {
      // The redirect URI comes from the server so it matches the value the
      // authorize route will send — `APP_URL` is not visible to the browser.
      const [{ clientId: existingId, clientSecret: existingSecret }, uri] = await Promise.all([
        getPlatformCredentials(platform),
        getConnectRedirectUri(platform),
      ]);
      if (existingId) setClientId(existingId);
      if (existingSecret) setClientSecret(existingSecret);
      setRedirectUri(uri);
    } finally {
      setLoadingKeys(false);
    }
  };

  const copyRedirectUri = async () => {
    if (!redirectUri) return;
    try {
      await navigator.clipboard.writeText(redirectUri);
      setCopiedUri(true);
      setTimeout(() => setCopiedUri(false), 2000);
    } catch {
      setModalError("Could not copy automatically — select the URL and copy it manually.");
    }
  };

  const handleSave = async () => {
    if (!clientId.trim() || !clientSecret.trim()) {
      setModalError("Both Client ID and Client Secret are required");
      return;
    }
    setSaving(true);
    setModalError("");
    try {
      const result = await savePlatformCredentials(selectedPlatform, clientId.trim(), clientSecret.trim());
      if (result.success) {
        setModalSuccess("Credentials saved securely");
        setConfigured((prev) => new Set([...prev, selectedPlatform]));
        setTestResults((prev) => { const n = { ...prev }; delete n[selectedPlatform]; return n; });
        setTimeout(() => setModalOpen(false), 800);
      } else {
        setModalError(result.error || "Failed to save");
      }
    } catch (e: any) {
      setModalError(e.message || "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async (platformId: string) => {
    setTestingPlatform(platformId);
    try {
      const result = await testPlatformCredentials(platformId);
      setTestResults((prev) => ({ ...prev, [platformId]: result }));
    } catch (e: any) {
      setTestResults((prev) => ({ ...prev, [platformId]: { valid: false, message: e.message || "Test failed" } }));
    } finally {
      setTestingPlatform(null);
    }
  };

  /**
   * Start (or restart) the provider's OAuth flow for a platform — either the one
   * open in the modal or, from a card's Reconnect button, the one clicked.
   *
   * Restarting is the whole point: an OAuth grant belongs to the token it was
   * issued for, so a connection whose permission set has changed — a Threads
   * Tester invitation accepted, a permission approved in App Review — or whose
   * session has expired only picks the new grant up through a fresh
   * authorization. `authorize` replaces the stored row on success, so nothing
   * has to be cleared first.
   */
  const startOAuthFor = (platform: string) => {
    window.location.href = `/api/connect/${platform}/authorize`;
  };

  const startOAuth = () => startOAuthFor(selectedPlatform);

  /**
   * Validate the pasted bot token and chat against the Bot API, then store the
   * connection. Success and failure both land inside the modal — unlike OAuth,
   * there is no redirect to carry the result.
   */
  const handleTelegramConnect = async () => {
    setTgConnecting(true);
    setModalError("");
    setModalSuccess("");
    try {
      const result = await connectTelegramAction(tgToken, tgChat);
      if (result.success) {
        setModalSuccess(`Connected — posts will go to ${result.chat ?? "the chat"}.`);
        setTgToken("");
        await refreshData();
      } else {
        setModalError(result.error || "Could not connect to Telegram.");
      }
    } catch (e) {
      setModalError(e instanceof Error ? e.message : "Could not connect to Telegram.");
    } finally {
      setTgConnecting(false);
    }
  };

  /**
   * Delete the stored connection. Deliberately behind a confirmation: it is the
   * one action here that removes something the user may still want, and it sits
   * next to Reconnect, which is the button they actually came for.
   */
  const handleDisconnect = async () => {
    setDisconnecting(true);
    setModalError("");
    try {
      const result = await disconnectPlatform(selectedPlatform);
      if (!result.success) {
        setModalError(result.error || "Failed to disconnect");
        return;
      }
      setConnected((prev) => {
        const next = new Set(prev);
        next.delete(selectedPlatform);
        return next;
      });
      setPermissionsMissing((prev) => {
        const next = new Set(prev);
        next.delete(selectedPlatform);
        return next;
      });
      setExpired((prev) => {
        const next = new Set(prev);
        next.delete(selectedPlatform);
        return next;
      });
      setConfirmDisconnect(false);
      setModalOpen(false);
    } catch (e) {
      setModalError(e instanceof Error ? e.message : "Failed to disconnect");
    } finally {
      setDisconnecting(false);
    }
  };

  const PLATFORMS = allPlatforms();
  const selectedMeta = PLATFORMS.find((p) => p.id === selectedPlatform);
  const selConfigured = configured.has(selectedPlatform);
  const selConnected = connected.has(selectedPlatform);
  const selNeedsReconnect = permissionsMissing.has(selectedPlatform);
  const selExpired = expired.has(selectedPlatform);
  const selTest = testResults[selectedPlatform];
  const selTesting = testingPlatform === selectedPlatform;

  return (
    <div className="space-y-6 relative">
      <GradientMesh />
      <div className="relative z-10">
        <motion.div initial={{ opacity: 0, y: -12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }} className="flex items-baseline justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight"><WordReveal text="Connected Accounts" /></h1>
            <p className="text-sm text-muted-foreground"><WordReveal text="Configure credentials, test them, then connect each platform." delay={0.15} /></p>
          </div>
        </motion.div>

        <AnimatePresence>
          {showFeedback && (
            <motion.div
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              className={`mt-4 rounded-xl border px-4 py-3 text-sm flex flex-wrap items-center gap-2 ${
                connectedPlatform
                  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                  : "border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400"
              }`}
            >
              {connectedPlatform ? (
                <><CheckCircle2 className="size-4 shrink-0" /> Connected to <span className="font-semibold capitalize">{connectedPlatform}</span>!</>
              ) : (
                <>
                  <XCircle className="size-4 shrink-0" /> Connection failed: <span className="font-medium">{describeConnectError(safeDecode(errorParam ?? "unknown"))}</span>
                  {/* The Threads permission fix ends in a reconnect, and the only
                      button that starts one lives in that platform's settings —
                      so hand it over rather than making the sentence do the work
                      of a UI. */}
                  {safeDecode(errorParam ?? "") === "threads_permissions_not_granted" && (
                    <Button variant="outline" size="sm" className="rounded-xl gap-1 ml-auto shrink-0" onClick={() => openModal("threads")}>
                      <RefreshCw className="size-3" /> Open Threads settings
                    </Button>
                  )}
                </>
              )}
            </motion.div>
          )}
        </AnimatePresence>

        <StaggerChildren className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 mt-6">
          {PLATFORMS.map((platform) => {
            const isConfigured = configured.has(platform.id);
            const isConnected = connected.has(platform.id);
            const needsReconnect = permissionsMissing.has(platform.id);
            const isExpired = expired.has(platform.id);
            const testResult = testResults[platform.id];
            const isTesting = testingPlatform === platform.id;

            return (
              <motion.div key={platform.id} variants={staggerItem}>
                <motion.div whileHover={{ y: -4 }} transition={{ type: "spring", stiffness: 300, damping: 22 }} className="h-full rounded-2xl border border-border bg-card p-5 hover:border-gold-500/30 hover:shadow-xl hover:shadow-gold-500/5 transition-colors">
                  <div className="flex items-start gap-3">
                    <motion.div whileHover={{ scale: 1.1, rotate: 3 }} transition={{ type: "spring", stiffness: 400, damping: 15 }}>
                      <PlatformIcon platform={platform.id as never} size={32} />
                    </motion.div>
                    <div className="flex-1 min-w-0">
                      <CardTitle className="text-base">{platform.name}</CardTitle>
                      <CardDescription className="text-xs mt-0.5">{platform.accountModel.join(" / ")}</CardDescription>
                    </div>
                    {isConnected ? (
                      needsReconnect ? (
                        <Badge variant="outline" className="text-[10px] shrink-0 gap-1 border-amber-500/40 text-amber-600 dark:text-amber-400">
                          <AlertTriangle className="size-3" /> {THREADS_PERMISSION_BADGE}
                        </Badge>
                      ) : isExpired ? (
                        <Badge variant="outline" className="text-[10px] shrink-0 gap-1 border-amber-500/40 text-amber-600 dark:text-amber-400">
                          <AlertTriangle className="size-3" /> {TOKEN_EXPIRED_BADGE}
                        </Badge>
                      ) : (
                        <Badge variant="gold" className="text-[10px] shrink-0 gap-1"><CheckCircle2 className="size-3" /> Connected</Badge>
                      )
                    ) : isConfigured ? (
                      <Badge variant="secondary" className="text-[10px] shrink-0">Configured</Badge>
                    ) : null}
                  </div>

                  <ul className="mt-3 space-y-1 text-xs text-muted-foreground">
                    {platform.content.rules.slice(0, 2).map((rule) => (
                      <li key={rule} className="flex items-start gap-1.5">
                        <span className="text-gold-500 mt-0.5 shrink-0">•</span>
                        <span className="leading-snug">{rule}</span>
                      </li>
                    ))}
                  </ul>

                  <AnimatePresence>
                    {testResult && (
                      <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="mt-3 overflow-hidden">
                        <div className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs ${testResult.valid ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20" : "bg-red-500/10 text-red-600 dark:text-red-400 border border-red-500/20"}`}>
                          {testResult.valid ? <CheckCircle2 className="size-3.5 shrink-0" /> : <XCircle className="size-3.5 shrink-0" />}
                          <span>{testResult.message}</span>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>

                  {/* One footer, three pieces of state: the media rules, a
                      Reconnect that starts OAuth straight from the card — the
                      connection this page exists to repair must not be buried in
                      a modal — and Config for credentials. The Reconnect button
                      only appears once a connection exists to replace. */}
                  <div className="mt-4 pt-4 border-t border-border flex items-center justify-between gap-2">
                    <div className="text-xs text-muted-foreground truncate pr-1">
                      <span>Media: </span>
                      <span className="font-medium">{platform.content.mediaTypes.join(", ")}</span>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      {isConnected && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="rounded-xl gap-1"
                          onClick={() =>
                            platform.connection === "manual"
                              ? openModal(platform.id)
                              : startOAuthFor(platform.id)
                          }
                        >
                          <RefreshCw className="size-3" /> Reconnect
                        </Button>
                      )}

                      <MagneticButton strength={0.12}>
                        <Button variant="gold" size="sm" className="rounded-xl gap-1" onClick={() => openModal(platform.id)}>
                          <Settings className="size-3" /> Config
                        </Button>
                      </MagneticButton>
                    </div>
                  </div>
                </motion.div>
              </motion.div>
            );
          })}
        </StaggerChildren>

        <BlurFade delay={0.3}>
          <p className="mt-8 text-center text-xs text-muted-foreground">
            Connections use official OAuth 2.0 where the platform supports it — Telegram connects
            with your own bot token. Credentials are encrypted with AES-256-GCM before storage.
          </p>
        </BlurFade>
      </div>

      {/* Platform Settings Modal */}
      <Dialog open={modalOpen} onOpenChange={setModalOpen}>
        <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2.5">
              <PlatformIcon platform={selectedPlatform as never} size={22} />
              {selectedMeta?.name} Settings
            </DialogTitle>
            <DialogDescription>
              Manage the connection and review platform requirements.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-5 py-1">
            {/* Status */}
            <div className="flex flex-wrap items-center gap-2">
              {selConnected && (
                selNeedsReconnect ? (
                  <Badge variant="outline" className="gap-1 border-amber-500/40 text-amber-600 dark:text-amber-400">
                    <AlertTriangle className="size-3" /> {THREADS_PERMISSION_BADGE}
                  </Badge>
                ) : selExpired ? (
                  <Badge variant="outline" className="gap-1 border-amber-500/40 text-amber-600 dark:text-amber-400">
                    <AlertTriangle className="size-3" /> {TOKEN_EXPIRED_BADGE}
                  </Badge>
                ) : (
                  <Badge variant="gold" className="gap-1"><CheckCircle2 className="size-3" /> Connected</Badge>
                )
              )}
              {selectedMeta?.connection !== "manual" &&
                (selConfigured ? (
                  <Badge variant="secondary">Credentials saved</Badge>
                ) : (
                  <Badge variant="outline">No credentials yet</Badge>
                ))}
              {selTest && (
                selTest.valid ? (
                  <Badge variant="secondary" className="gap-1 text-emerald-600 dark:text-emerald-400"><CheckCircle2 className="size-3" /> Keys valid</Badge>
                ) : (
                  <Badge variant="outline" className="gap-1 text-red-600 dark:text-red-400 border-red-500/30"><XCircle className="size-3" /> Keys invalid</Badge>
                )
              )}
            </div>

            {/* Connection */}
            <section className="rounded-xl border border-border p-4 space-y-3">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Connection</h4>
              {selectedMeta?.connection === "manual" ? (
                <>
                  <p className="text-sm text-muted-foreground">
                    Paste your bot&apos;s token and the chat it should post to. The bot must be a
                    member of the chat — an administrator of any channel.
                  </p>
                  <ol className="space-y-1 text-xs text-muted-foreground list-decimal list-inside">
                    <li>
                      In Telegram, message <span className="font-medium text-foreground">@BotFather</span>{" "}
                      → <code>/newbot</code> → copy the token.
                    </li>
                    <li>
                      Channel: add the bot as an administrator with the right to post. Group: just add it.
                    </li>
                    <li>
                      Paste the chat below as its <code>@username</code> or numeric ID (<code>-100…</code>).
                    </li>
                  </ol>
                  <div className="space-y-2">
                    <Label htmlFor="tg-token">Bot token</Label>
                    <Input
                      id="tg-token"
                      type="password"
                      autoComplete="off"
                      value={tgToken}
                      onChange={(e) => setTgToken(e.target.value)}
                      placeholder="123456789:AA…"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="tg-chat">Chat</Label>
                    <Input
                      id="tg-chat"
                      value={tgChat}
                      onChange={(e) => setTgChat(e.target.value)}
                      placeholder="@mychannel or -1001234567890"
                    />
                  </div>
                  <AnimatePresence mode="wait">
                    {modalError && <motion.p key="err" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} className="text-sm text-red-600 dark:text-red-400 flex items-center gap-1.5"><XCircle className="size-3.5 shrink-0" /> {modalError}</motion.p>}
                    {modalSuccess && <motion.p key="ok" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} className="text-sm text-emerald-600 dark:text-emerald-400 flex items-center gap-1.5"><CheckCircle2 className="size-3.5 shrink-0" /> {modalSuccess}</motion.p>}
                  </AnimatePresence>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      variant="gold"
                      size="sm"
                      className="rounded-xl gap-1"
                      onClick={handleTelegramConnect}
                      disabled={tgConnecting || !tgToken.trim() || !tgChat.trim()}
                    >
                      {tgConnecting ? <Loader2 className="size-3 animate-spin" /> : <Link2 className="size-3" />}
                      {tgConnecting ? "Connecting…" : selConnected ? "Update connection" : "Connect Telegram"}
                    </Button>
                    {selConnected && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="rounded-xl gap-1 text-red-600 dark:text-red-400"
                        onClick={() => setConfirmDisconnect(true)}
                      >
                        <Unlink className="size-3" /> Disconnect
                      </Button>
                    )}
                  </div>
                </>
              ) : selConnected ? (
                <>
                  <p className="text-sm text-muted-foreground">
                    This platform is linked through official OAuth. You can publish to it from the Composer.
                  </p>
                  {selNeedsReconnect && (
                    <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
                      <AlertTriangle className="size-3.5 shrink-0 mt-0.5" />
                      <span>{THREADS_PERMISSION_FIX}</span>
                    </div>
                  )}
                  {selExpired && (
                    <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
                      <AlertTriangle className="size-3.5 shrink-0 mt-0.5" />
                      <span>{TOKEN_EXPIRED_FIX}</span>
                    </div>
                  )}
                  <p className="text-xs text-muted-foreground">
                    Reconnect after the app&apos;s permissions change — the provider binds a grant to the
                    token it was issued for, so an older connection keeps the older permissions.
                  </p>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button variant="gold" size="sm" className="rounded-xl gap-1" onClick={startOAuth}>
                      <RefreshCw className="size-3" /> Reconnect via OAuth
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="rounded-xl gap-1 text-red-600 dark:text-red-400"
                      onClick={() => setConfirmDisconnect(true)}
                    >
                      <Unlink className="size-3" /> Disconnect
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  <p className="text-sm text-muted-foreground">
                    {selConfigured
                      ? "Credentials saved. Connect your account via OAuth to enable publishing."
                      : "Save your developer app credentials below first — then connect via OAuth."}
                  </p>
                  <Button
                    variant={selConfigured ? "gold" : "outline"}
                    size="sm"
                    className="rounded-xl gap-1"
                    disabled={!selConfigured}
                    onClick={startOAuth}
                  >
                    <Link2 className="size-3" /> Connect via OAuth
                  </Button>
                </>
              )}
            </section>

            {/* Credentials — hidden for manual platforms (Telegram), whose only
                credential is the per-user bot token held in the Connection form. */}
            {selectedMeta?.connection !== "manual" && (
            <section className="rounded-xl border border-border p-4 space-y-3">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Developer App Credentials</h4>
              {loadingKeys ? (
                <div className="flex items-center justify-center py-6 gap-2">
                  <Loader2 className="size-4 animate-spin text-gold-500" />
                  <span className="text-sm text-muted-foreground">Loading existing credentials...</span>
                </div>
              ) : (
                <>
                  {selectedMeta?.auth?.credentialHint && (
                    <p className="flex items-start gap-2 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
                      <AlertTriangle className="size-3.5 shrink-0 mt-0.5" />
                      <span>{selectedMeta.auth?.credentialHint}</span>
                    </p>
                  )}
                  <div className="space-y-2">
                    <Label htmlFor="modal-clientId">Client ID</Label>
                    <Input id="modal-clientId" value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="e.g., 1234567890123456" />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="modal-clientSecret">Client Secret</Label>
                    <Input id="modal-clientSecret" type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} placeholder="e.g., abcdef1234567890abcdef1234567890" />
                  </div>
                  {redirectUri && (
                    <div className="space-y-1.5 rounded-lg border border-border bg-muted/40 p-3">
                      <p className="text-xs text-muted-foreground">
                        Register this exact URL as a valid OAuth redirect URI in the provider&#39;s app settings
                        (Threads: Use cases → Threads → Settings → Client OAuth Settings). Providers compare it
                        character for character, including any trailing slash.
                      </p>
                      <div className="flex items-center gap-2">
                        <code className="min-w-0 flex-1 break-all rounded bg-background px-2 py-1.5 text-[11px] leading-relaxed">
                          {redirectUri}
                        </code>
                        <Button variant="ghost" size="sm" className="gap-1 rounded-xl shrink-0" onClick={copyRedirectUri}>
                          {copiedUri ? <Check className="size-3 text-emerald-500" /> : <Copy className="size-3" />}
                          {copiedUri ? "Copied" : "Copy"}
                        </Button>
                      </div>
                    </div>
                  )}
                  <AnimatePresence mode="wait">
                    {modalError && <motion.p key="err" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} className="text-sm text-red-600 dark:text-red-400 flex items-center gap-1.5"><XCircle className="size-3.5 shrink-0" /> {modalError}</motion.p>}
                    {modalSuccess && <motion.p key="ok" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} className="text-sm text-emerald-600 dark:text-emerald-400 flex items-center gap-1.5"><CheckCircle2 className="size-3.5 shrink-0" /> {modalSuccess}</motion.p>}
                  </AnimatePresence>
                  <AnimatePresence>
                    {selTest && (
                      <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
                        <div className={`flex items-start gap-2 px-3 py-2 rounded-lg text-xs ${selTest.valid ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20" : "bg-red-500/10 text-red-600 dark:text-red-400 border border-red-500/20"}`}>
                          {selTest.valid ? <CheckCircle2 className="size-3.5 shrink-0 mt-0.5" /> : <XCircle className="size-3.5 shrink-0 mt-0.5" />}
                          <span>{selTest.message}</span>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                  <div className="flex items-center gap-2 pt-1">
                    <Button variant="gold" onClick={handleSave} disabled={saving || loadingKeys || !clientId || !clientSecret} className="gap-1 rounded-xl">
                      {saving ? <Loader2 className="size-3 animate-spin" /> : null}
                      Save Keys
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => handleTest(selectedPlatform)}
                      disabled={!selConfigured || selTesting}
                      className="gap-1 rounded-xl"
                    >
                      {selTesting ? <Loader2 className="size-3 animate-spin" /> : selTest?.valid ? <CheckCircle2 className="size-3" /> : <TestTube2 className="size-3" />}
                      {selTesting ? "Testing…" : selTest?.valid ? "Valid" : "Test Keys"}
                    </Button>
                  </div>
                </>
              )}
            </section>
            )}

            {/* Platform requirements */}
            {selectedMeta && (
              <section className="rounded-xl border border-border p-4 space-y-2.5">
                <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Platform Requirements</h4>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <span>Account: <span className="font-medium text-foreground">{selectedMeta.accountModel.join(" / ")}</span></span>
                  <span>Media: <span className="font-medium text-foreground">{selectedMeta.content.mediaTypes.join(", ")}</span></span>
                </div>
                <ul className="space-y-1 text-xs text-muted-foreground">
                  {selectedMeta.content.rules.map((rule) => (
                    <li key={rule} className="flex items-start gap-1.5">
                      <span className="text-gold-500 mt-0.5 shrink-0">•</span>
                      <span className="leading-snug">{rule}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setModalOpen(false)} className="rounded-xl">Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Disconnect confirmation. Disconnecting is the only way back to a clean
          "not connected" state, and it is irreversible from the UI — the next
          step is a fresh authorization — so it does not get to be one click
          while Reconnect sits beside it. */}
      <Dialog open={confirmDisconnect} onOpenChange={setConfirmDisconnect}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Unlink className="size-4 text-red-500" /> Disconnect {selectedMeta?.name}?
            </DialogTitle>
            <DialogDescription>
              The stored access token is deleted from Hilbras Studio, so nothing can publish to{" "}
              {selectedMeta?.name} until you connect again. Nothing is posted or removed on{" "}
              {selectedMeta?.name} itself, and your saved app credentials are kept.
            </DialogDescription>
          </DialogHeader>
          <AnimatePresence>
            {modalError && (
              <motion.p key={modalError} initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} className="text-sm text-red-600 dark:text-red-400 flex items-center gap-1.5">
                <XCircle className="size-3.5 shrink-0" /> {modalError}
              </motion.p>
            )}
          </AnimatePresence>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDisconnect(false)} className="rounded-xl">Cancel</Button>
            <Button variant="gold" onClick={handleDisconnect} disabled={disconnecting} className="rounded-xl gap-1">
              {disconnecting ? <Loader2 className="size-3 animate-spin" /> : <Unlink className="size-3" />}
              {disconnecting ? "Disconnecting…" : "Disconnect"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}