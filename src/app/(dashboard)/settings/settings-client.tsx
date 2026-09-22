"use client";

import { useActionState, useState, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { ThemeToggle } from "@/components/theme-toggle";
import {
  Shield,
  User,
  Palette,
  Brain,
  Loader2,
  Lock,
  Pencil,
  Trash2,
  Plus,
  Sparkles,
  Wifi,
  WifiOff,
  X,
} from "lucide-react";
import { GradientMesh } from "@/components/motion/gradient-mesh";
import { WordReveal } from "@/components/motion/word-reveal";
import { MagneticButton } from "@/components/motion/magnetic-button";
import { BlurFade } from "@/components/motion/blur-fade";
import { Ripple } from "@/components/motion/ripple";
import { StaggerChildren, staggerItem } from "@/components/motion/stagger-children";
import {
  updateProfileAction,
  changePasswordAction,
  updatePreferencesAction,
} from "@/app/actions/settings";
import {
  saveAiProviderAction,
  deleteAiProviderAction,
  setDefaultAiProviderAction,
  testPingProviderAction,
  listAiProviders,
  type AiProviderItem,
  type AiProviderFormState,
} from "@/app/actions/ai-providers";
import {
  deleteAssistantMemory,
  clearAssistantMemories,
  type MemoryItem,
} from "@/app/actions/chat";

type Prefs = {
  autoHashtags: boolean;
  adaptTone: boolean;
  autoSchedule: boolean;
  engagementNotifications: boolean;
};

const PREF_META: Record<keyof Prefs, { label: string; desc: string }> = {
  autoHashtags: { label: "Auto-generate hashtags", desc: "AI adds relevant hashtags per platform" },
  adaptTone: { label: "Adapt tone per platform", desc: "Adjusts writing style for X vs LinkedIn vs Instagram" },
  autoSchedule: { label: "Auto-schedule posts", desc: "AI picks the optimal posting time" },
  engagementNotifications: { label: "Engagement notifications", desc: "Notify when posts get significant engagement" },
};

function FormMessage({ state }: { state: { error?: string; success?: string } }) {
  if (!state.error && !state.success) return null;
  return (
    <motion.p initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }}
      className={`rounded-xl border px-3 py-2 text-xs ${state.error ? "border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400" : "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"}`}>
      {state.error ?? state.success}
    </motion.p>
  );
}

function SectionHeader({ icon: Icon, title, desc }: { icon: React.ComponentType<{ className?: string }>; title: string; desc: string }) {
  return (
    <div className="flex items-center gap-2">
      <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-gold-400 to-gold-600 flex items-center justify-center shadow-md shadow-gold-500/20 shrink-0">
        <Icon className="size-3.5 text-white" />
      </div>
      <div>
        <CardTitle className="text-sm">{title}</CardTitle>
        <CardDescription className="text-[11px]">{desc}</CardDescription>
      </div>
    </div>
  );
}

function SectionLabel({ icon: Icon, label }: { icon: React.ComponentType<{ className?: string }>; label: string }) {
  return (
    <div className="flex items-center gap-2">
      <Icon className="size-4 text-gold-500" />
      <span className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">{label}</span>
      <div className="flex-1 h-px bg-border" />
    </div>
  );
}

function StubbornInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  const ref = useRef<HTMLInputElement>(null);
  const handleFocus = useCallback(() => { if (ref.current) ref.current.removeAttribute("readonly"); }, []);
  const handleBlur = useCallback(() => { if (ref.current) ref.current.setAttribute("readonly", ""); }, []);
  return <Input ref={ref} autoComplete="off" readOnly onFocus={handleFocus} onBlur={handleBlur} {...props} className={props.className} />;
}

export function SettingsClient({ user, preferences, providers = [], memories = [] }: {
  user: { name: string; email: string; username: string };
  preferences: Prefs;
  providers?: AiProviderItem[];
  memories?: MemoryItem[];
}) {
  const [profileState, profileAction, profilePending] = useActionState(updateProfileAction, {});
  const [passwordState, passwordAction, passwordPending] = useActionState(changePasswordAction, {});
  const [localProviders, setLocalProviders] = useState<AiProviderItem[]>(providers);
  const [prefs, setPrefs] = useState<Prefs>(preferences);
  // The provider form calls the action directly (it needs to refresh the list
  // on success), so its result lives here — not in useActionState, whose
  // dispatcher is never invoked and whose state would never update.
  const [savingProvider, setSavingProvider] = useState(false);
  const [aiFormMsg, setAiFormMsg] = useState<AiProviderFormState>({});
  const [activeMsg, setActiveMsg] = useState<AiProviderFormState>({});
  const [editingProvider, setEditingProvider] = useState<AiProviderItem | null>(null);
  const [viewingProvider, setViewingProvider] = useState<AiProviderItem | null>(null);
  const [localMemories, setLocalMemories] = useState<MemoryItem[]>(memories);
  const [pingResult, setPingResult] = useState<Record<string, { ok: boolean; latencyMs?: number; error?: string }>>({});
  const [pinging, setPinging] = useState<string | null>(null);
  const [activatingProvider, setActivatingProvider] = useState<string | null>(null);

  const refreshProviders = async () => { setLocalProviders(await listAiProviders()); };
  const handleDeleteProvider = async (id: string) => { await deleteAiProviderAction(id); await refreshProviders(); setViewingProvider(null); };
  const handleActivateProvider = async (id: string) => {
    setActiveMsg({});
    setActivatingProvider(id);
    // Flip optimistically: the controlled select otherwise snaps back to the
    // old value for the whole server round-trip, which reads as "didn't work".
    const previous = localProviders;
    setLocalProviders((ps) => ps.map((p) => ({ ...p, isDefault: p.id === id })));
    try {
      const r = await setDefaultAiProviderAction(id);
      if (!r.ok) throw new Error(r.error ?? "Could not switch the active model.");
      await refreshProviders();
    } catch (err) {
      setLocalProviders(previous);
      setActiveMsg({
        error: err instanceof Error ? err.message : "Could not switch the active model.",
      });
    } finally {
      setActivatingProvider(null);
    }
  };
  const handlePrefToggle = (key: keyof Prefs) => { const v = !prefs[key]; setPrefs((p) => ({ ...p, [key]: v })); updatePreferencesAction({ ...prefs, [key]: v }); };
  const handlePing = async (id: string) => { setPinging(id); const r = await testPingProviderAction(id); setPingResult((prev) => ({ ...prev, [id]: r })); setPinging(null); };
  const forgetMemory = async (id: string) => {
    await deleteAssistantMemory(id);
    setLocalMemories((prev) => prev.filter((m) => m.id !== id));
  };
  const forgetAllMemories = async () => {
    if (!window.confirm("Forget everything the Assistant remembers about you?")) return;
    await clearAssistantMemories();
    setLocalMemories([]);
  };

  const activeId = localProviders.find((p) => p.isDefault)?.id ?? "";
  const noneSelected = localProviders.length > 0 && activeId === "";

  return (
    <div className="relative">
      <GradientMesh />
      <div className="relative z-10">
        <motion.div initial={{ opacity: 0, y: -12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }}>
          <h1 className="text-2xl font-bold tracking-tight"><WordReveal text="Settings" /></h1>
          <p className="text-sm text-muted-foreground"><WordReveal text="Manage your account and AI configuration." delay={0.15} /></p>
        </motion.div>

        {/* ── Account ─────────────────────────────────── */}
        <section className="mt-4">
          <SectionLabel icon={User} label="Account" />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-2">
            {/* Profile */}
            <StaggerChildren className="contents">
              <motion.div variants={staggerItem}>
                <BlurFade><Ripple className="rounded-xl h-full">
                  <Card className="h-full">
                    <CardHeader><SectionHeader icon={User} title="Profile" desc="Your account details." /></CardHeader>
                    <CardContent>
                      <form action={profileAction} className="space-y-3">
                        <FormMessage state={profileState} />
                        <div className="space-y-3">
                          <div className="space-y-1.5">
                            <Label htmlFor="name">Name</Label>
                            <StubbornInput id="name" name="name" defaultValue={user.name} required minLength={2} className="rounded-xl" />
                          </div>
                          <div className="space-y-1.5">
                            <Label htmlFor="username">Username</Label>
                            <div className="relative">
                              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground pointer-events-none">@</span>
                              <StubbornInput id="username" name="username" defaultValue={user.username} required minLength={3} maxLength={20} className="pl-8 rounded-xl" />
                            </div>
                          </div>
                          <div className="space-y-1.5">
                            <Label htmlFor="email">Email</Label>
                            <StubbornInput id="email" defaultValue={user.email} disabled className="rounded-xl opacity-70" />
                          </div>
                        </div>
                        <MagneticButton strength={0.1}>
                          <Button type="submit" variant="gold" size="sm" disabled={profilePending} className="rounded-xl gap-1">
                            {profilePending && <Loader2 className="size-3 animate-spin" />} Save Changes
                          </Button>
                        </MagneticButton>
                      </form>
                    </CardContent>
                  </Card>
                </Ripple></BlurFade>
              </motion.div>

              <motion.div variants={staggerItem}>
                <BlurFade delay={0.03}><Ripple className="rounded-xl h-full">
                  <Card className="h-full">
                    <CardHeader><SectionHeader icon={Lock} title="Password" desc="Change your login password." /></CardHeader>
                    <CardContent>
                      <form action={passwordAction} className="space-y-3">
                        <FormMessage state={passwordState} />
                        <div className="space-y-3">
                          <div className="space-y-1.5">
                            <Label htmlFor="currentPassword">Current</Label>
                            <StubbornInput id="currentPassword" name="currentPassword" type="password" required className="rounded-xl" />
                          </div>
                          <div className="space-y-1.5">
                            <Label htmlFor="newPassword">New</Label>
                            <StubbornInput id="newPassword" name="newPassword" type="password" required minLength={8} className="rounded-xl" />
                          </div>
                          <div className="space-y-1.5">
                            <Label htmlFor="confirmPassword">Confirm</Label>
                            <StubbornInput id="confirmPassword" name="confirmPassword" type="password" required minLength={8} className="rounded-xl" />
                          </div>
                        </div>
                        <Button type="submit" variant="outline" size="sm" disabled={passwordPending} className="rounded-xl gap-1">
                          {passwordPending && <Loader2 className="size-3 animate-spin" />} Change Password
                        </Button>
                      </form>
                    </CardContent>
                  </Card>
                </Ripple></BlurFade>
              </motion.div>
            </StaggerChildren>
          </div>
        </section>

        {/* ── AI ─────────────────────────────────────── */}
        <section className="mt-4">
          <SectionLabel icon={Brain} label="AI" />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-2">
            <StaggerChildren className="contents">
              {/* AI Provider */}
              <motion.div variants={staggerItem}>
                <BlurFade><Ripple className="rounded-xl h-full">
                  <Card className="h-full">
                    <CardHeader>
                      <div className="flex items-center justify-between">
                        <SectionHeader icon={Sparkles} title="AI Provider" desc="Configure any compatible API." />
                        <Badge variant="gold" className="gap-1 shrink-0 ml-2"><Shield className="size-3" /> Encrypted</Badge>
                      </div>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      <form
                        action={async (formData: FormData) => {
                          setSavingProvider(true);
                          setAiFormMsg({});
                          try {
                            const r = await saveAiProviderAction({}, formData);
                            setAiFormMsg(r);
                            if (r.success) { await refreshProviders(); setEditingProvider(null); }
                          } catch {
                            setAiFormMsg({ error: "Could not save the provider — try again." });
                          } finally {
                            setSavingProvider(false);
                          }
                        }}
                        className="space-y-3 p-3 rounded-xl border border-dashed border-border bg-muted/30"
                      >
                        <div className="flex items-center gap-2 mb-1">
                          <Plus className="size-4 text-gold-500" />
                          <span className="text-sm font-medium">{editingProvider ? "Edit Provider" : "Add Provider"}</span>
                          {editingProvider && <Button type="button" variant="ghost" size="sm" className="ml-auto text-xs" onClick={() => setEditingProvider(null)}>Cancel</Button>}
                        </div>
                        {editingProvider && <input type="hidden" name="id" value={editingProvider.id} />}
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                          <div className="space-y-1">
                            <Label htmlFor="ai-name" className="text-xs">Name</Label>
                            <StubbornInput name="name" id="ai-name" placeholder="e.g., My OpenRouter" defaultValue={editingProvider?.name ?? ""} required className="rounded-lg text-sm h-9" />
                          </div>
                          <div className="space-y-1">
                            <Label htmlFor="ai-apiFormat" className="text-xs">API Format</Label>
                            <select name="apiFormat" id="ai-apiFormat" required defaultValue={editingProvider?.apiFormat ?? "openai"} className="flex h-9 w-full rounded-lg border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-gold-500/30">
                              <option value="openai">OpenAI-compatible</option>
                              <option value="anthropic">Anthropic-compatible</option>
                            </select>
                          </div>
                        </div>
                        <div className="space-y-1">
                          <Label htmlFor="ai-baseUrl" className="text-xs">Base URL</Label>
                          <StubbornInput name="baseUrl" id="ai-baseUrl" placeholder="https://api.openai.com/v1" defaultValue={editingProvider?.baseUrl ?? ""} required className="rounded-lg text-sm h-9" />
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                          <div className="space-y-1">
                            <Label htmlFor="ai-apiKey" className="text-xs">API Key</Label>
                            <StubbornInput name="apiKey" id="ai-apiKey" type="password" placeholder={editingProvider ? "••••••••" : "API key..."} className="rounded-lg text-sm h-9" {...(!editingProvider ? { required: true } : {})} />
                          </div>
                          <div className="space-y-1">
                            <Label htmlFor="ai-modelId" className="text-xs">Model ID</Label>
                            <StubbornInput name="modelId" id="ai-modelId" placeholder="gpt-4o" defaultValue={editingProvider?.modelId ?? ""} required className="rounded-lg text-sm h-9" />
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <MagneticButton strength={0.1}>
                            <Button type="submit" variant="gold" size="sm" disabled={savingProvider} className="rounded-lg gap-1 text-xs">
                              {savingProvider && <Loader2 className="size-3 animate-spin" />}
                              {editingProvider ? "Update" : "Save"}
                            </Button>
                          </MagneticButton>
                          <FormMessage state={aiFormMsg} />
                        </div>
                      </form>

                      <div className="space-y-2">
                        {localProviders.map((p) => (
                          <div key={p.id} className="flex items-center gap-2 p-2.5 rounded-xl border border-border bg-card hover:border-gold-500/30 transition-colors">
                            <input
                              type="radio"
                              name="active-ai-model"
                              aria-label={`Use ${p.name}`}
                              className="size-3.5 shrink-0 accent-gold-500 cursor-pointer disabled:cursor-not-allowed"
                              checked={activeId === p.id}
                              disabled={activatingProvider !== null}
                              onChange={() => handleActivateProvider(p.id)}
                            />
                            <div className="w-7 h-7 rounded-lg bg-gold-500/10 flex items-center justify-center shrink-0">
                              <Sparkles className="size-3.5 text-gold-500" />
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-1.5">
                                <p className="text-xs font-medium truncate">{p.name}</p>
                                {p.isDefault && (
                                  <Badge variant="gold" className="text-[9px] px-1 py-0">Active</Badge>
                                )}
                                {pingResult[p.id] && (
                                  <Badge variant={pingResult[p.id].ok ? "gold" : "outline"} className="text-[9px] px-1 py-0 gap-0.5">
                                    {pingResult[p.id].ok ? <Wifi className="size-2" /> : <WifiOff className="size-2" />}
                                    {pingResult[p.id].ok ? `${pingResult[p.id].latencyMs}ms` : "Fail"}
                                  </Badge>
                                )}
                              </div>
                              <p className="text-[10px] text-muted-foreground truncate">
                                {p.modelId} · {p.apiFormat}
                              </p>
                            </div>
                            <div className="flex items-center gap-0.5">
                              <Button variant="ghost" size="icon" className="size-7 rounded-lg" title="Test" disabled={pinging === p.id} onClick={() => handlePing(p.id)}>
                                {pinging === p.id ? <Loader2 className="size-3 animate-spin" /> : <Wifi className="size-3" />}
                              </Button>
                              <Button variant="ghost" size="icon" className="size-7 rounded-lg" title="Edit" onClick={() => { setEditingProvider(p); setViewingProvider(p); }}>
                                <Pencil className="size-3" />
                              </Button>
                              <Button variant="ghost" size="icon" className="size-7 rounded-lg hover:bg-red-500/10 hover:text-red-500" title="Delete" onClick={() => handleDeleteProvider(p.id)}>
                                <Trash2 className="size-3" />
                              </Button>
                            </div>
                          </div>
                        ))}
                      </div>
                      {noneSelected && (
                        <p className="text-[10px] text-muted-foreground">
                          Select a model for the Assistant.
                        </p>
                      )}
                      <FormMessage state={activeMsg} />
                      {localProviders.length === 0 && (
                        <div className="py-2 text-center text-xs text-muted-foreground">
                          <p>No models yet — add your API provider above.</p>
                        </div>
                      )}
                      <p className="text-[10px] text-muted-foreground">Keys encrypted with AES-256-GCM.</p>
                    </CardContent>
                  </Card>
                </Ripple></BlurFade>
              </motion.div>

              {/* AI Preferences */}
              <motion.div variants={staggerItem}>
                <BlurFade delay={0.03}><Ripple className="rounded-xl h-full">
                  <Card className="h-full">
                    <CardHeader><SectionHeader icon={Brain} title="AI Preferences" desc="Saved to your account." /></CardHeader>
                    <CardContent className="space-y-0">
                      {(Object.keys(PREF_META) as (keyof Prefs)[]).map((key) => (
                        <div key={key} className="flex items-center justify-between py-3 border-b border-border last:border-0">
                          <div>
                            <p className="text-sm font-medium">{PREF_META[key].label}</p>
                            <p className="text-xs text-muted-foreground">{PREF_META[key].desc}</p>
                          </div>
                          <Switch checked={prefs[key]} onCheckedChange={() => handlePrefToggle(key)} />
                        </div>
                      ))}
                    </CardContent>
                  </Card>
                </Ripple></BlurFade>
              </motion.div>

              {/* Assistant Memory — long-term facts kept across chats */}
              <motion.div variants={staggerItem} className="md:col-span-2">
                <BlurFade delay={0.045}><Ripple className="rounded-xl">
                  <Card>
                    <CardHeader>
                      <div className="flex items-start justify-between gap-3">
                        <SectionHeader icon={Brain} title="Assistant Memory" desc="Facts the Assistant remembers in every chat. Extracted automatically — delete any you don't want kept." />
                        {localMemories.length > 0 && (
                          <Button variant="ghost" size="sm" className="text-xs text-red-500 hover:text-red-600 shrink-0" onClick={forgetAllMemories}>
                            Forget all
                          </Button>
                        )}
                      </div>
                    </CardHeader>
                    <CardContent className="space-y-2">
                      {localMemories.length === 0 ? (
                        <p className="text-xs text-muted-foreground">
                          Nothing saved yet — tell the Assistant things like your brand voice, audience, or products and it will remember them here.
                        </p>
                      ) : (
                        localMemories.map((m) => (
                          <div key={m.id} className="flex items-start gap-2 rounded-xl border border-border bg-muted/30 px-3 py-2">
                            <p className="flex-1 text-xs leading-relaxed">{m.content}</p>
                            <button
                              type="button"
                              title="Forget this"
                              onClick={() => forgetMemory(m.id)}
                              className="p-1 rounded text-muted-foreground hover:text-red-500 transition-colors shrink-0"
                            >
                              <Trash2 className="size-3.5" />
                            </button>
                          </div>
                        ))
                      )}
                    </CardContent>
                  </Card>
                </Ripple></BlurFade>
              </motion.div>
            </StaggerChildren>
          </div>
        </section>

        {/* ── Appearance ─────────────────────────────── */}
        <section className="mt-4 mb-8">
          <SectionLabel icon={Palette} label="Appearance" />
          <div className="mt-2">
            <BlurFade><Ripple className="rounded-xl">
              <Card><CardContent className="py-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium">Dark Mode</p>
                    <p className="text-xs text-muted-foreground">Toggle between light and dark theme.</p>
                  </div>
                  <ThemeToggle />
                </div>
              </CardContent></Card>
            </Ripple></BlurFade>
          </div>
        </section>
      </div>

      {/* ── Provider Detail Dialog ─────────────────── */}
      <AnimatePresence>
        {viewingProvider && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={() => setViewingProvider(null)}>
            <motion.div initial={{ opacity: 0, scale: 0.95, y: 8 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95, y: 8 }}
              transition={{ duration: 0.2 }} className="w-full max-w-md rounded-2xl border border-border bg-card p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center justify-between mb-5">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-gold-400 to-gold-600 flex items-center justify-center">
                    <Sparkles className="size-5 text-white" />
                  </div>
                  <div>
                    <h2 className="font-semibold">{viewingProvider.name}</h2>
                    <p className="text-xs text-muted-foreground">{viewingProvider.isDefault ? "Active provider" : "Provider"}</p>
                  </div>
                </div>
                <button onClick={() => setViewingProvider(null)} className="p-1.5 rounded-lg hover:bg-accent transition-colors">
                  <X className="size-4 text-muted-foreground" />
                </button>
              </div>
              <div className="space-y-3">
                <DetailRow label="Base URL" value={viewingProvider.baseUrl} />
                <DetailRow label="API Format" value={viewingProvider.apiFormat === "openai" ? "OpenAI-compatible" : "Anthropic-compatible"} />
                <DetailRow label="Model ID" value={viewingProvider.modelId} />
                <DetailRow label="API Key" value={viewingProvider.apiKeyMasked} />
                <DetailRow label="Created" value={new Date(viewingProvider.createdAt).toLocaleDateString()} />
              </div>
              <div className="flex gap-2 mt-6">
                <Button variant="outline" size="sm" className="rounded-xl gap-1 flex-1" disabled={pinging === viewingProvider.id} onClick={() => handlePing(viewingProvider.id)}>
                  {pinging === viewingProvider.id ? <Loader2 className="size-3 animate-spin" /> : <Wifi className="size-3" />} Test Ping
                </Button>
                <Button variant="gold" size="sm" className="rounded-xl gap-1 flex-1" onClick={() => { setEditingProvider(viewingProvider); setViewingProvider(null); }}>
                  <Pencil className="size-3" /> Edit
                </Button>
              </div>
              {pingResult[viewingProvider.id] && (
                <div className={`mt-3 rounded-xl border px-3 py-2 text-xs ${pingResult[viewingProvider.id].ok ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" : "border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400"}`}>
                  {pingResult[viewingProvider.id].ok ? `Connected in ${pingResult[viewingProvider.id].latencyMs}ms` : `Failed: ${pingResult[viewingProvider.id].error}`}
                </div>
              )}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-2 border-b border-border last:border-0">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-xs font-medium text-right max-w-[60%] truncate">{value}</span>
    </div>
  );
}
