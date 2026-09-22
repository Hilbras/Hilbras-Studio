"use client";

import * as React from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Sparkles,
  Send,
  ImagePlus,
  Link,
  Hash,
  Calendar,
  Loader2,
  Wand2,
  Copy,
  Check,
  XCircle,
  CheckCircle2,
  AlertTriangle,
  Lightbulb,
  Languages,
  Clock,
  FileText,
  Trash2,
  Eye,
  ChevronDown,
  Film,
} from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { PlatformIcon } from "@/components/platform-icon";
import { PLATFORMS, type Platform } from "@/components/platform-icon";
import { GradientMesh } from "@/components/motion/gradient-mesh";
import { WordReveal } from "@/components/motion/word-reveal";
import { MagneticButton } from "@/components/motion/magnetic-button";
import { BlurFade } from "@/components/motion/blur-fade";
import { Ripple } from "@/components/motion/ripple";
import { OrbitingDots } from "@/components/motion/orbiting-dots";
import { StaggerChildren, staggerItem } from "@/components/motion/stagger-children";
import { improvePostAction, generateHashtagsAction } from "@/app/actions/ai";
import { publishToAllNowAction } from "@/app/actions/publish";
import { createPostAction, listPosts, deletePost, recordPublishOutcome, getConnectedPlatforms, getConfiguredPlatforms, type PostItem } from "@/app/actions/posts";

const AI_SUGGESTIONS = [
  { icon: Lightbulb, text: "Product launch announcement" },
  { icon: Languages, text: "Weekly industry roundup" },
  { icon: Sparkles, text: "Behind-the-scenes story" },
];

const HASHTAG_SUGGESTIONS = [
  ["#AI", "#SocialMedia", "#Hilbras", "#Innovation"],
  ["#TechStartup", "#GrowthHacking", "#ContentStrategy"],
  ["#DigitalMarketing", "#MarketingTips", "#BrandBuilding"],
];

export default function ComposerPage() {
  const [draft, setDraft] = React.useState("");
  const [connected, setConnected] = React.useState<Platform[]>([]);
  const [configured, setConfigured] = React.useState<Platform[]>([]);
  const [selected, setSelected] = React.useState<Platform[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const [imageUrl, setImageUrl] = React.useState("");
  /** Lets the media button jump to the field that publishes actually read. */
  const mediaInputRef = React.useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = React.useState(false);
  const [uploadError, setUploadError] = React.useState("");
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const [publishing, setPublishing] = React.useState(false);
  const [publishResults, setPublishResults] = React.useState<
    Array<{ platform: string; success: boolean; postId?: string; error?: string; url?: string }>
  >([]);

  // Schedule mode
  const [scheduleMode, setScheduleMode] = React.useState(false);
  const [scheduledDate, setScheduledDate] = React.useState("");
  const [scheduledTime, setScheduledTime] = React.useState("09:00");

  // Post queue
  const [posts, setPosts] = React.useState<PostItem[]>([]);
  const [showQueue, setShowQueue] = React.useState(false);
  /** AI tool failures — kept out of the draft so they can't be published. */
  const [aiError, setAiError] = React.useState("");

  // Load connected + configured platforms from database + posts
  React.useEffect(() => {
    Promise.all([
      getConnectedPlatforms(),
      getConfiguredPlatforms(),
    ]).then(([conn, conf]) => {
      const connectedPlatforms = conn as Platform[];
      const configuredPlatforms = conf as Platform[];
      setConnected(connectedPlatforms);
      setConfigured(configuredPlatforms);
      setSelected(connectedPlatforms); // auto-select connected only
    });
    listPosts().then(setPosts);
  }, []);

  const toggle = (p: Platform) =>
    setSelected((s) => (s.includes(p) ? s.filter((x) => x !== p) : [...s, p]));

  // Upload a local image; the server stores it and returns a public URL,
  // which fills the same field the URL flow uses — publish is unchanged.
  const handleUploadFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // let the same file be re-picked after a failure
    if (!file) return;
    setUploadError("");
    if (!file.type.startsWith("image/")) {
      setUploadError("Only images can be uploaded.");
      return;
    }
    if (file.size > 4 * 1024 * 1024) {
      setUploadError("Image is over 4 MB — compress it or use a URL instead.");
      return;
    }
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/media", { method: "POST", body: fd });
      const body = (await res.json().catch(() => ({}))) as {
        url?: string;
        error?: string;
      };
      if (!res.ok || !body.url) {
        throw new Error(body.error || `Upload failed (${res.status})`);
      }
      setImageUrl(body.url);
    } catch (err) {
      setUploadError(
        err instanceof Error ? err.message : "Upload failed — try again."
      );
    } finally {
      setUploading(false);
    }
  };

  // Improve the post in the editor (or write a fresh one when it's empty).
  // This is an editor tool, not a chat: the result must be pure post text,
  // which improvePostAction guarantees — so errors get their own line instead
  // of landing in the draft where they could be published by accident.
  const handleGenerate = async () => {
    setLoading(true);
    setAiError("");
    try {
      const result = await improvePostAction(draft, selected);
      if (result.error) {
        setAiError(result.error);
      } else {
        setDraft(result.content);
      }
    } catch (e) {
      setAiError(e instanceof Error ? e.message : "AI request failed.");
    } finally {
      setLoading(false);
    }
  };

  // Generate hashtags
  const handleGenerateHashtags = async () => {
    if (!draft.trim()) return;
    setLoading(true);
    setAiError("");
    try {
      const result = await generateHashtagsAction(draft);
      if (result.error) {
        setAiError(result.error);
      } else if (result.content) {
        setDraft(draft + "\n\n" + result.content);
      }
    } catch (e) {
      setAiError(e instanceof Error ? e.message : "AI request failed.");
    } finally {
      setLoading(false);
    }
  };

  // Publish / Schedule
  const handlePublish = async () => {
    if (!draft.trim() || selected.length === 0) return;

    setPublishing(true);
    try {
      const scheduledAt = scheduleMode && scheduledDate
        ? new Date(`${scheduledDate}T${scheduledTime}:00`)
        : undefined;

      // Save to DB first
      const saveResult = await createPostAction(draft, selected, imageUrl || undefined, scheduledAt);

      if (scheduledAt) {
        setPublishResults([{ platform: "all", success: true, postId: saveResult.postId, error: undefined, url: undefined }]);
        setDraft("");
        setImageUrl("");
        listPosts().then(setPosts);
        return;
      }

      // Publish immediately
      const results = await publishToAllNowAction(draft, imageUrl || undefined, selected);
      setPublishResults(results);

      // Save results
      if (saveResult.postId) {
        await recordPublishOutcome(saveResult.postId, results);
      }

      listPosts().then(setPosts);
    } catch (e) {
      setPublishResults([{ platform: "all", success: false, error: e instanceof Error ? e.message : "Publish failed." }]);
    } finally {
      setPublishing(false);
    }
  };

  const handleDelete = async (postId: string) => {
    await deletePost(postId);
    setPosts((prev) => prev.filter((p) => p.id !== postId));
  };

  return (
    <div className="space-y-6 relative">
      <GradientMesh />

      <div className="relative z-10">
        <motion.div initial={{ opacity: 0, y: -12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }} className="flex items-baseline justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">
              <WordReveal text="Create Post" />
            </h1>
            <p className="text-sm text-muted-foreground">
              <WordReveal text="Write manually or let the AI generate content. Publish now or schedule for later." delay={0.15} />
            </p>
          </div>
          <Button variant="outline" size="sm" className="gap-1 rounded-xl" onClick={() => setShowQueue(!showQueue)}>
            <FileText className="size-3" /> Post Queue ({posts.length})
          </Button>
        </motion.div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mt-6">
          {/* Left: editor + tools */}
          <div className="lg:col-span-2 space-y-4">
            {/* AI Tools bar */}
            <BlurFade delay={0.05}>
              <Card className="border-gold-500/20 bg-gradient-to-r from-gold-500/5 to-transparent hover:shadow-xl hover:shadow-gold-500/10 transition-all duration-300">
                <CardContent className="p-4">
                  <div className="flex items-center gap-3 mb-3">
                    <div className="relative">
                      <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-gold-400 to-gold-600 flex items-center justify-center shadow-md shadow-gold-500/20">
                        <Sparkles className="size-4 text-black" />
                      </div>
                      <OrbitingDots count={5} radius={16} duration={6} dotSize={1.5} className="absolute -inset-2" />
                    </div>
                    <span className="text-sm font-semibold">AI Assistant</span>
                  </div>
                  <div className="flex gap-2 flex-wrap">
                    <MagneticButton strength={0.15}>
                      <Button variant="gold" size="sm" className="gap-1 rounded-xl" onClick={handleGenerate} disabled={loading}>
                        {loading ? <Loader2 className="size-3 animate-spin" /> : <Wand2 className="size-3" />}
                        {draft.trim() ? "Improve Post" : "Generate"}
                      </Button>
                    </MagneticButton>
                    <MagneticButton strength={0.15}>
                      <Button variant="outline" size="sm" className="gap-1 rounded-xl" onClick={handleGenerateHashtags} disabled={loading || !draft.trim()}>
                        <Hash className="size-3" /> Hashtags
                      </Button>
                    </MagneticButton>
                    {AI_SUGGESTIONS.map((s, i) => (
                      <motion.button
                        key={i}
                        whileHover={{ scale: 1.05, y: -1 }}
                        whileTap={{ scale: 0.95 }}
                        onClick={() => setDraft(s.text)}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border/50 bg-muted/50 text-xs text-muted-foreground hover:text-foreground hover:border-gold-500/30 transition-all"
                      >
                        <s.icon className="size-3" />
                        {s.text}
                      </motion.button>
                    ))}
                  </div>
                  {aiError && (
                    <p className="mt-2 text-xs text-red-500">{aiError}</p>
                  )}
                </CardContent>
              </Card>
            </BlurFade>

            {/* Editor */}
            <BlurFade delay={0.1}>
              <Ripple className="rounded-xl">
                <Card className="hover:shadow-xl hover:shadow-gold-500/10 transition-all duration-300">
                  <CardContent className="p-4 space-y-3">
                    <textarea
                      className="w-full h-36 rounded-xl border border-input bg-muted/50 px-4 py-3 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-gold-500/30 focus:border-gold-500/30 resize-none transition-all duration-200"
                      placeholder='Write your post or describe what you want the AI to create...'
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                    />

                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <input
                          ref={fileInputRef}
                          type="file"
                          accept="image/jpeg,image/png,image/webp,image/gif"
                          className="hidden"
                          onChange={handleUploadFile}
                        />
                        <Button
                          variant="outline"
                          size="sm"
                          className="gap-1 rounded-xl"
                          onClick={() => fileInputRef.current?.click()}
                          disabled={uploading}
                        >
                          {uploading ? (
                            <Loader2 className="size-3 animate-spin" />
                          ) : (
                            <ImagePlus className="size-3" />
                          )}
                          {uploading ? "Uploading..." : "Upload Image"}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="gap-1 rounded-xl"
                          onClick={() => mediaInputRef.current?.focus()}
                        >
                          <Link className="size-3" /> Media URL
                        </Button>
                        <span className="text-[10px] text-muted-foreground">
                          {draft.length} characters
                        </span>
                      </div>
                      {draft && (
                        <Button variant="ghost" size="sm" className="gap-1 rounded-xl" onClick={() => { navigator.clipboard.writeText(draft); setCopied(true); setTimeout(() => setCopied(false), 2000); }}>
                          {copied ? <Check className="size-3 text-emerald-500" /> : <Copy className="size-3" />}
                          {copied ? "Copied" : "Copy"}
                        </Button>
                      )}
                    </div>
                  </CardContent>
                </Card>
              </Ripple>
            </BlurFade>

            {/* Media URL */}
            <BlurFade delay={0.12}>
              <Card className="hover:shadow-lg transition-shadow duration-300">
                <CardContent className="p-4">
                  <Label htmlFor="mediaUrl" className="text-xs text-muted-foreground flex items-center gap-1.5 mb-1.5">
                    <Film className="size-3" /> Media — upload an image or paste a URL (required for Instagram and Threads media posts)
                  </Label>
                  <Input ref={mediaInputRef} id="mediaUrl" value={imageUrl} onChange={(e) => setImageUrl(e.target.value)} placeholder="https://example.com/image.jpg — a .mp4/.mov link posts as Threads video" className="rounded-xl text-sm" />
                  {(imageUrl || uploadError) && (
                    <div className="flex items-center gap-3 mt-2">
                      {imageUrl && (
                        // Arbitrary user-pasted hosts can't be whitelisted for
                        // next/image; this is a 56px preview, not an asset.
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={imageUrl}
                          alt="Media preview"
                          className="h-14 w-14 rounded-lg object-cover border border-border"
                          onError={(e) => {
                            // External URLs that refuse hotlinking just skip
                            // the thumbnail; the URL itself stays valid.
                            e.currentTarget.style.display = "none";
                          }}
                        />
                      )}
                      {imageUrl && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="gap-1 rounded-xl text-muted-foreground"
                          onClick={() => setImageUrl("")}
                        >
                          <XCircle className="size-3" /> Clear
                        </Button>
                      )}
                      {uploadError && (
                        <p className="text-xs text-red-500">{uploadError}</p>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>
            </BlurFade>

            {/* Schedule toggle */}
            <BlurFade delay={0.14}>
              <Card className="hover:shadow-lg transition-shadow duration-300">
                <CardContent className="p-4">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <Clock className="size-4 text-muted-foreground" />
                      <Label className="text-sm font-medium">Schedule for later</Label>
                    </div>
                    <Switch checked={scheduleMode} onCheckedChange={setScheduleMode} />
                  </div>

                  <AnimatePresence>
                    {scheduleMode && (
                      <motion.div
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: "auto" }}
                        exit={{ opacity: 0, height: 0 }}
                        className="overflow-hidden"
                      >
                        <div className="grid grid-cols-2 gap-3 mt-3">
                          <div className="space-y-1.5">
                            <Label className="text-xs">Date</Label>
                            <Input type="date" value={scheduledDate} onChange={(e) => setScheduledDate(e.target.value)} className="rounded-xl text-sm" min={new Date().toISOString().split("T")[0]} />
                          </div>
                          <div className="space-y-1.5">
                            <Label className="text-xs">Time</Label>
                            <Input type="time" value={scheduledTime} onChange={(e) => setScheduledTime(e.target.value)} className="rounded-xl text-sm" />
                          </div>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </CardContent>
              </Card>
            </BlurFade>

            {/* Publish button */}
            <BlurFade delay={0.16}>
              <Card className="hover:shadow-xl hover:shadow-gold-500/10 transition-shadow duration-300 border-gold-500/20">
                <CardContent className="p-4">
                  <div className="flex items-center gap-3">
                    <MagneticButton strength={0.15}>
                      <Button variant="gold" className="gap-1 rounded-xl" onClick={handlePublish} disabled={publishing || !draft.trim() || selected.length === 0}>
                        {publishing ? <Loader2 className="size-3 animate-spin" /> : scheduleMode ? <Calendar className="size-3" /> : <Send className="size-3" />}
                        {publishing ? "Processing..." : scheduleMode ? `Schedule for ${selected.length} platform${selected.length > 1 ? "s" : ""}` : `Publish to ${selected.length} platform${selected.length > 1 ? "s" : ""}`}
                      </Button>
                    </MagneticButton>
                    {!draft.trim() && <span className="text-xs text-muted-foreground">Write something first</span>}
                  </div>
                </CardContent>
              </Card>
            </BlurFade>

            {/* Publish results */}
            <AnimatePresence>
              {publishResults.length > 0 && (
                <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
                  <Card className="hover:shadow-xl hover:shadow-gold-500/10 transition-shadow duration-300">
                    <CardHeader>
                      <CardTitle className="text-sm flex items-center gap-2">
                        {publishResults.every((r) => r.success) ? <CheckCircle2 className="size-4 text-emerald-500" /> : <AlertTriangle className="size-4 text-amber-500" />}
                        Publish Results
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-2">
                      {publishResults.map((r, i) => (
                        <div key={i} className={`flex items-center gap-2 p-3 rounded-xl text-sm ${r.success ? "bg-emerald-500/10 border border-emerald-500/20" : "bg-red-500/10 border border-red-500/20"}`}>
                          <PlatformIcon platform={r.platform as Platform} size={20} className="shrink-0" />
                          <span className="capitalize font-medium">{r.platform}</span>
                          {r.success ? (
                            <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400 text-xs ml-auto">
                              <CheckCircle2 className="size-3" /> Published
                              {r.url && <a href={r.url} target="_blank" rel="noopener" className="underline ml-1">View</a>}
                            </span>
                          ) : (
                            <span className="text-red-600 dark:text-red-400 text-xs ml-auto">{r.error}</span>
                          )}
                        </div>
                      ))}
                    </CardContent>
                  </Card>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* Right sidebar: platforms + queue */}
          <div className="space-y-4">
            {/* Platform selector */}
            <BlurFade delay={0.1}>
              <Card className="hover:shadow-xl hover:shadow-gold-500/10 transition-shadow duration-300">
                <CardHeader>
                  <CardTitle className="text-sm">Target Platforms</CardTitle>
                  <CardDescription>Select where to post</CardDescription>
                </CardHeader>
                <CardContent className="space-y-1.5">
                  {PLATFORMS.map((p, i) => {
                    const isPlatformConnected = connected.includes(p);
                    const isPlatformConfigured = configured.includes(p);
                    return (
                      <motion.button
                        key={p}
                        disabled={!isPlatformConnected}
                        onClick={() => toggle(p)}
                        initial={{ opacity: 0, x: 16 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ delay: 0.15 + i * 0.03 }}
                        whileHover={isPlatformConnected ? { x: 4 } : undefined}
                        whileTap={isPlatformConnected ? { scale: 0.98 } : undefined}
                        className={`flex items-center gap-3 w-full rounded-xl px-3 py-2.5 text-sm transition-all duration-200 ${
                          selected.includes(p)
                            ? "bg-gold-500/15 text-gold-600 dark:text-gold-400 shadow-sm shadow-gold-500/5"
                            : isPlatformConnected
                              ? "hover:bg-accent/60 text-muted-foreground"
                              : isPlatformConfigured
                                ? "hover:bg-accent/40 text-muted-foreground"
                                : "opacity-40 cursor-not-allowed text-muted-foreground"
                        }`}
                      >
                        <PlatformIcon platform={p} size={20} />
                        <span className="capitalize">{p}</span>
                        {!isPlatformConnected && !isPlatformConfigured && (
                          <Badge variant="secondary" className="ml-auto text-[10px]">Not connected</Badge>
                        )}
                        {isPlatformConfigured && !isPlatformConnected && (
                          <Badge variant="gold" className="ml-auto text-[10px]">Ready to connect</Badge>
                        )}
                        {selected.includes(p) && isPlatformConnected && (
                          <motion.div initial={{ scale: 0 }} animate={{ scale: 1 }} className="ml-auto">
                            <Check className="size-3 text-gold-500" />
                          </motion.div>
                        )}
                      </motion.button>
                    );
                  })}
                </CardContent>
              </Card>
            </BlurFade>

            {/* Post Queue */}
            {showQueue && (
              <BlurFade delay={0.15}>
                <Card className="hover:shadow-xl hover:shadow-gold-500/10 transition-shadow duration-300">
                  <CardHeader>
                    <CardTitle className="text-sm flex items-center gap-2">
                      <FileText className="size-4 text-gold-500" />
                      Post Queue
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2 max-h-80 overflow-y-auto">
                    {posts.length === 0 ? (
                      <p className="text-xs text-muted-foreground text-center py-4">No posts yet</p>
                    ) : (
                      posts.map((post) => (
                        <div key={post.id} className="p-3 rounded-xl border border-border bg-muted/30 hover:bg-muted/50 transition-colors">
                          <div className="flex items-start justify-between gap-2">
                            <div className="flex-1 min-w-0">
                              <p className="text-xs text-foreground line-clamp-2">{post.content}</p>
                              <div className="flex items-center gap-2 mt-1.5">
                                <Badge variant={post.status === "published" ? "gold" : post.status === "scheduled" ? "secondary" : "outline"} className="text-[10px]">
                                  {post.status}
                                </Badge>
                                <span className="text-[10px] text-muted-foreground">
                                  {post.platforms.split(",").length} platforms
                                </span>
                                <span className="text-[10px] text-muted-foreground">
                                  {new Date(post.createdAt).toLocaleDateString()}
                                </span>
                              </div>
                            </div>
                            <Button variant="ghost" size="icon" className="size-6 rounded-lg hover:bg-red-500/10 hover:text-red-500" onClick={() => handleDelete(post.id)}>
                              <Trash2 className="size-3" />
                            </Button>
                          </div>
                        </div>
                      ))
                    )}
                  </CardContent>
                </Card>
              </BlurFade>
            )}

            {/* Quick tips */}
            <BlurFade delay={0.2}>
              <Card className="hover:shadow-lg transition-shadow duration-300">
                <CardHeader>
                  <CardTitle className="text-sm flex items-center gap-2">
                    <Lightbulb className="size-4 text-gold-500" />
                    Quick Tips
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 text-xs text-muted-foreground">
                  <p>• Instagram requires an image — upload one or paste a URL</p>
                  <p>• X supports text up to 280 characters</p>
                  <p>• Schedule posts for optimal engagement times</p>
                  <p>• Use the AI to generate hashtags automatically</p>
                </CardContent>
              </Card>
            </BlurFade>
          </div>
        </div>
      </div>
    </div>
  );
}