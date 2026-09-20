"use client";

import { motion, AnimatePresence } from "framer-motion";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, useCallback } from "react";
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
} from "lucide-react";
import { allPlatforms, type PlatformId } from "@/lib/platforms";
import {
  getPlatformCredentials,
  savePlatformCredentials,
  testPlatformCredentials,
  checkCredentialsExist,
} from "@/app/actions/platform";

type TestResult = { valid: boolean; message: string };

export default function AccountsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const connectedPlatform = searchParams.get("connected");
  const errorParam = searchParams.get("error");
  const [showFeedback, setShowFeedback] = useState(false);

  const [configured, setConfigured] = useState<Set<string>>(new Set());
  const [connected, setConnected] = useState<Set<string>>(new Set());

  const [modalOpen, setModalOpen] = useState(false);
  const [selectedPlatform, setSelectedPlatform] = useState<string>("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [loadingKeys, setLoadingKeys] = useState(false);
  const [saving, setSaving] = useState(false);
  const [modalError, setModalError] = useState("");
  const [modalSuccess, setModalSuccess] = useState("");

  const [testResults, setTestResults] = useState<Record<string, TestResult>>({});
  const [testingPlatform, setTestingPlatform] = useState<string | null>(null);

  const refreshData = useCallback(async () => {
    const platforms = allPlatforms();
    const [confResults, connResults] = await Promise.all([
      Promise.all(platforms.map(async (p) => ({ id: p.id, exists: await checkCredentialsExist(p.id) }))),
      // Check OAuth connections — look for the platform in the DB query
      // We'll use a simple approach: check if the social_accounts page returns data
      (async () => {
        try {
          const res = await fetch("/api/check-connections");
          if (res.ok) return await res.json() as { connected: string[] };
        } catch {}
        return { connected: [] as string[] };
      })(),
    ]);
    setConfigured(new Set(confResults.filter((r) => r.exists).map((r) => r.id)));
    setConnected(new Set(connResults.connected));
  }, []);

  useEffect(() => { refreshData(); }, [refreshData]);

  useEffect(() => {
    if (connectedPlatform || errorParam) {
      setShowFeedback(true);
      const t = setTimeout(() => setShowFeedback(false), 5000);
      // Re-check connections after OAuth redirect
      refreshData();
      return () => clearTimeout(t);
    }
  }, [connectedPlatform, errorParam, refreshData]);

  useEffect(() => {
    if (connectedPlatform || errorParam) {
      const url = new URL(window.location.href);
      url.searchParams.delete("connected");
      url.searchParams.delete("error");
      setTimeout(() => router.replace(url.pathname + url.search, { scroll: false }), 0);
    }
  }, [connectedPlatform, errorParam, router]);

  const openModal = async (platform: string) => {
    setSelectedPlatform(platform);
    setClientId("");
    setClientSecret("");
    setModalError("");
    setModalSuccess("");
    setModalOpen(true);
    setLoadingKeys(true);
    try {
      const { clientId: existingId, clientSecret: existingSecret } = await getPlatformCredentials(platform);
      if (existingId) setClientId(existingId);
      if (existingSecret) setClientSecret(existingSecret);
    } finally {
      setLoadingKeys(false);
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

  const PLATFORMS = allPlatforms();
  const selectedMeta = PLATFORMS.find((p) => p.id === selectedPlatform);
  const selConfigured = configured.has(selectedPlatform);
  const selConnected = connected.has(selectedPlatform);
  const selTest = testResults[selectedPlatform];
  const selTesting = testingPlatform === selectedPlatform;

  return (
    <div className="space-y-6 relative">
      <GradientMesh />
      <div className="relative z-10">
        <motion.div initial={{ opacity: 0, y: -12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }} className="flex items-baseline justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight"><WordReveal text="Connected Accounts" /></h1>
            <p className="text-sm text-muted-foreground"><WordReveal text="Configure credentials, test them, then connect via OAuth." delay={0.15} /></p>
          </div>
        </motion.div>

        <AnimatePresence>
          {showFeedback && (
            <motion.div
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              className={`mt-4 rounded-xl border px-4 py-3 text-sm flex items-center gap-2 ${
                connectedPlatform
                  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                  : "border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400"
              }`}
            >
              {connectedPlatform ? (
                <><CheckCircle2 className="size-4 shrink-0" /> Connected to <span className="font-semibold capitalize">{connectedPlatform}</span>!</>
              ) : (
                <><XCircle className="size-4 shrink-0" /> Connection failed: <span className="font-medium">{decodeURIComponent(errorParam ?? "unknown")}</span></>
              )}
            </motion.div>
          )}
        </AnimatePresence>

        <StaggerChildren className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 mt-6">
          {PLATFORMS.map((platform) => {
            const isConfigured = configured.has(platform.id);
            const isConnected = connected.has(platform.id);
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
                      <Badge variant="gold" className="text-[10px] shrink-0 gap-1"><CheckCircle2 className="size-3" /> Connected</Badge>
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

                  <div className="mt-4 pt-4 border-t border-border flex items-center justify-between">
                    <div className="text-xs text-muted-foreground">
                      <span>Media: </span>
                      <span className="font-medium">{platform.content.mediaTypes.join(", ")}</span>
                    </div>

                  <div className="mt-4 pt-4 border-t border-border flex items-center justify-between">
                    <div className="text-xs text-muted-foreground truncate pr-3">
                      <span>Media: </span>
                      <span className="font-medium">{platform.content.mediaTypes.join(", ")}</span>
                    </div>

                    <MagneticButton strength={0.12}>
                      <Button variant="gold" size="sm" className="rounded-xl gap-1 shrink-0" onClick={() => openModal(platform.id)}>
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
            All connections use official OAuth 2.0. Credentials are encrypted with AES-256-GCM before storage.
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
              Manage API keys, OAuth connection, and review platform requirements.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-5 py-1">
            {/* Status */}
            <div className="flex flex-wrap items-center gap-2">
              {selConnected && (
                <Badge variant="gold" className="gap-1"><CheckCircle2 className="size-3" /> Connected</Badge>
              )}
              {selConfigured ? (
                <Badge variant="secondary">Credentials saved</Badge>
              ) : (
                <Badge variant="outline">No credentials yet</Badge>
              )}
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
              {selConnected ? (
                <p className="text-sm text-muted-foreground">
                  This platform is linked through official OAuth. You can publish to it from the Composer.
                </p>
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
                    onClick={() => { window.location.href = `/api/connect/${selectedPlatform}/authorize`; }}
                  >
                    <Link2 className="size-3" /> Connect via OAuth
                  </Button>
                </>
              )}
            </section>

            {/* Credentials */}
            <section className="rounded-xl border border-border p-4 space-y-3">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Developer App Credentials</h4>
              {loadingKeys ? (
                <div className="flex items-center justify-center py-6 gap-2">
                  <Loader2 className="size-4 animate-spin text-gold-500" />
                  <span className="text-sm text-muted-foreground">Loading existing credentials...</span>
                </div>
              ) : (
                <>
                  <div className="space-y-2">
                    <Label htmlFor="modal-clientId">Client ID</Label>
                    <Input id="modal-clientId" value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="e.g., 1234567890123456" />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="modal-clientSecret">Client Secret</Label>
                    <Input id="modal-clientSecret" type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} placeholder="e.g., abcdef1234567890abcdef1234567890" />
                  </div>
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
    </div>
  );
}