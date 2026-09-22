"use client";

import * as React from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Card,
  CardContent,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { GradientMesh } from "@/components/motion/gradient-mesh";
import { WordReveal } from "@/components/motion/word-reveal";
import { BlurFade } from "@/components/motion/blur-fade";
import { MagneticButton } from "@/components/motion/magnetic-button";
import { TypingText } from "@/components/motion/typing-text";
import { OrbitingDots } from "@/components/motion/orbiting-dots";
import {
  Sparkles,
  Send,
  Bot,
  User,
  Wand2,
  Calendar,
  BarChart3,
  Plus,
  ChevronDown,
  MessageSquare,
  Pencil,
  Trash2,
} from "lucide-react";
import type { ActiveModelInfo } from "@/lib/ai";
import {
  listChatSessions,
  loadChatSession,
  renameChatSession,
  deleteChatSession,
  type ChatSessionItem,
} from "@/app/actions/chat";

interface ChatMessage {
  id: string;
  role: "user" | "ai";
  text: string;
}

const QUICK_PROMPTS = [
  { icon: Wand2, label: "Draft a launch post for all platforms" },
  { icon: Calendar, label: "What should I post this week?" },
  { icon: BarChart3, label: "How did my content perform?" },
];

const WELCOME: ChatMessage = {
  id: "0",
  role: "ai",
  text: "Hi! I'm your social media copilot. Ask me to draft posts, analyze performance, or plan your week.",
};

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diffMs / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

export function AssistantClient({
  model,
  sessions = [],
}: {
  model: ActiveModelInfo;
  sessions?: ChatSessionItem[];
}) {
  const [messages, setMessages] = React.useState<ChatMessage[]>([WELCOME]);
  const [input, setInput] = React.useState("");
  const [thinking, setThinking] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [errorCode, setErrorCode] = React.useState<string | null>(null);
  const scrollRef = React.useRef<HTMLDivElement>(null);

  // Sessions — null means "unsaved new chat"; the id is minted on first send
  // so the server can title it from the first message.
  const [sessionList, setSessionList] = React.useState<ChatSessionItem[]>(sessions);
  const [sessionId, setSessionId] = React.useState<string | null>(null);
  const [activeTitle, setActiveTitle] = React.useState("New chat");
  const [sessionsOpen, setSessionsOpen] = React.useState(false);

  const refreshSessions = async () => setSessionList(await listChatSessions());

  // Keep the newest token in view while it streams in.
  React.useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, thinking]);

  const startNewChat = () => {
    if (thinking) return;
    setSessionId(null);
    setActiveTitle("New chat");
    setMessages([WELCOME]);
    setError(null);
    setErrorCode(null);
    setSessionsOpen(false);
  };

  const openSession = async (id: string) => {
    if (thinking || id === sessionId) {
      setSessionsOpen(false);
      return;
    }
    const data = await loadChatSession(id);
    setSessionsOpen(false);
    if (!data) return;
    setSessionId(id);
    setActiveTitle(data.title);
    setError(null);
    setErrorCode(null);
    setMessages(
      data.messages.map((m) => ({
        id: m.id,
        role: m.role === "user" ? "user" : "ai",
        text: m.content,
      }))
    );
  };

  const renameSessionById = async (id: string, current: string) => {
    const next = window.prompt("Rename chat", current);
    if (!next || !next.trim()) return;
    const r = await renameChatSession(id, next);
    if (r.ok) {
      if (id === sessionId) setActiveTitle(next.trim());
      await refreshSessions();
    } else if (r.error) {
      setError(r.error);
    }
  };

  const removeSession = async (id: string) => {
    if (!window.confirm("Delete this chat?")) return;
    await deleteChatSession(id);
    if (id === sessionId) startNewChat();
    await refreshSessions();
  };

  const send = async (text?: string) => {
    const msg = (text ?? input).trim();
    if (!msg || thinking) return;

    const isNew = sessionId === null;
    const id = sessionId ?? crypto.randomUUID();
    const userMsg: ChatMessage = { id: `u${Date.now()}`, role: "user", text: msg };
    const aiMsgId = `a${Date.now()}`;

    setMessages((prev) => [...prev, userMsg, { id: aiMsgId, role: "ai", text: "" }]);
    setInput("");
    setThinking(true);
    setError(null);
    setErrorCode(null);
    setSessionId(id);
    if (isNew) setActiveTitle(msg.replace(/\s+/g, " ").slice(0, 60));

    try {
      const res = await fetch("/api/assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: id, message: msg }),
      });

      if (!res.ok || !res.body) {
        const data = (await res.json().catch(() => null)) as { error?: string; code?: string } | null;
        setErrorCode(data?.code ?? null);
        throw new Error(data?.error ?? "The assistant request failed.");
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let acc = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        acc += decoder.decode(value, { stream: true });
        setThinking(false);
        setMessages((prev) => prev.map((m) => (m.id === aiMsgId ? { ...m, text: acc } : m)));
      }

      if (!acc.trim()) throw new Error("The model returned an empty response.");

      // The session now exists server-side — surface it in the picker.
      await refreshSessions();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Something went wrong.";
      setError(message);
      // A brand-new chat that never reached the server stays "new".
      if (isNew) setSessionId(null);
      setMessages((prev) =>
        prev.map((m) => (m.id === aiMsgId && !m.text ? { ...m, text: "Sorry — I couldn't complete that." } : m))
      );
    } finally {
      setThinking(false);
    }
  };

  return (
    <div className="space-y-6 relative flex flex-col h-[calc(100vh-8rem)]">
      <GradientMesh />

      <div className="relative z-10 flex flex-col h-full">
        <motion.div
          initial={{ opacity: 0, y: -12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
          className="flex flex-wrap items-end justify-between gap-3"
        >
          <div>
            <h1 className="text-2xl font-bold tracking-tight">
              <WordReveal text="AI Assistant" />
            </h1>
            <p className="text-sm text-muted-foreground">
              <WordReveal text="Your copilot for everything social." delay={0.15} />
            </p>
          </div>

          {/* Sessions */}
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="rounded-xl gap-1"
              onClick={startNewChat}
              disabled={thinking && !sessionId}
            >
              <Plus className="size-3.5" /> New chat
            </Button>

            <div className="relative">
              <button
                type="button"
                onClick={() => setSessionsOpen((o) => !o)}
                className="flex items-center gap-2 h-9 max-w-[15rem] rounded-xl border border-border bg-card px-3 text-sm text-muted-foreground hover:text-foreground hover:border-gold-500/30 transition-colors focus:outline-none focus:ring-2 focus:ring-gold-500/30"
              >
                <MessageSquare className="size-3.5 text-gold-500 shrink-0" />
                <span className="truncate">{activeTitle}</span>
                <ChevronDown className="size-3.5 shrink-0" />
              </button>

              <AnimatePresence>
                {sessionsOpen && (
                  <>
                    <div className="fixed inset-0 z-30" onClick={() => setSessionsOpen(false)} />
                    <motion.div
                      initial={{ opacity: 0, y: -4 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -4 }}
                      transition={{ duration: 0.15 }}
                      className="absolute right-0 z-40 mt-1.5 w-80 max-h-80 overflow-y-auto rounded-xl border border-border bg-card shadow-xl p-1.5"
                    >
                      {sessionList.length === 0 ? (
                        <p className="p-3 text-xs text-muted-foreground">
                          No chats yet — your conversations will be listed here.
                        </p>
                      ) : (
                        sessionList.map((s) => (
                          <div
                            key={s.id}
                            className={`group flex items-center gap-1 rounded-lg px-2 py-1.5 transition-colors ${
                              s.id === sessionId ? "bg-gold-500/10" : "hover:bg-accent"
                            }`}
                          >
                            <button
                              type="button"
                              onClick={() => openSession(s.id)}
                              className="flex-1 min-w-0 text-left"
                            >
                              <p className="text-xs font-medium truncate">{s.title}</p>
                              <p className="text-[10px] text-muted-foreground">{relativeTime(s.updatedAt)}</p>
                            </button>
                            <button
                              type="button"
                              title="Rename"
                              onClick={() => renameSessionById(s.id, s.title)}
                              className="p-1 rounded text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-foreground transition-all"
                            >
                              <Pencil className="size-3" />
                            </button>
                            <button
                              type="button"
                              title="Delete"
                              onClick={() => removeSession(s.id)}
                              className="p-1 rounded text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-red-500 transition-all"
                            >
                              <Trash2 className="size-3" />
                            </button>
                          </div>
                        ))
                      )}
                    </motion.div>
                  </>
                )}
              </AnimatePresence>
            </div>
          </div>
        </motion.div>

        {/* Chat area */}
        <BlurFade delay={0.1} className="flex-1 min-h-0 mt-4">
          <Card className="h-full flex flex-col overflow-hidden">
            <CardContent ref={scrollRef} className="flex-1 overflow-y-auto p-6 space-y-4">
              <AnimatePresence initial={false}>
                {messages.map((m) => (
                  <motion.div
                    key={m.id}
                    initial={{ opacity: 0, y: 12, scale: 0.97 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    transition={{ duration: 0.25 }}
                    className={`flex gap-3 ${m.role === "user" ? "justify-end" : ""}`}
                  >
                    {m.role === "ai" && (
                      <div className="relative shrink-0 self-end mb-1">
                        <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-gold-400 to-gold-600 flex items-center justify-center shadow-md shadow-gold-500/20">
                          <Bot className="size-4 text-white" />
                        </div>
                      </div>
                    )}
                    <div
                      className={`max-w-[75%] rounded-2xl px-4 py-3 text-sm leading-relaxed whitespace-pre-line ${
                        m.role === "user"
                          ? "bg-gold-500 text-white rounded-br-sm"
                          : "bg-muted rounded-tl-sm"
                      }`}
                    >
                      {m.text}
                    </div>
                    {m.role === "user" && (
                      <Avatar className="self-end mb-1 shrink-0">
                        <AvatarFallback className="bg-gradient-to-br from-gold-400 to-gold-600 text-white">
                          <User className="size-4" />
                        </AvatarFallback>
                      </Avatar>
                    )}
                  </motion.div>
                ))}

                {thinking && (
                  <motion.div
                    key="thinking"
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    className="flex gap-3"
                  >
                    <div className="relative w-8 h-8 self-end mb-1">
                      <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-gold-400 to-gold-600 flex items-center justify-center shadow-md shadow-gold-500/20">
                        <Bot className="size-4 text-white" />
                      </div>
                      <OrbitingDots count={6} radius={20} duration={4} dotSize={2} className="absolute -inset-2" />
                    </div>
                    <div className="bg-muted rounded-2xl rounded-tl-sm px-4 py-3 text-sm">
                      <TypingText texts={["Thinking…", "Analyzing your accounts…"]} typingSpeed={40} deletingSpeed={20} pauseDuration={800} />
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Empty state quick prompts */}
              {messages.length <= 1 && (
                <motion.div
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.4 }}
                  className="flex flex-wrap gap-2 pt-2"
                >
                  {QUICK_PROMPTS.map((q) => (
                    <motion.button
                      key={q.label}
                      whileHover={{ scale: 1.03, y: -2 }}
                      whileTap={{ scale: 0.97 }}
                      onClick={() => send(q.label)}
                      className="flex items-center gap-2 px-4 py-2.5 rounded-xl border border-border bg-card hover:border-gold-500/40 hover:bg-gold-500/[0.06] text-sm text-muted-foreground hover:text-foreground transition-all"
                    >
                      <q.icon className="size-4 text-gold-500" />
                      {q.label}
                    </motion.button>
                  ))}
                </motion.div>
              )}
            </CardContent>

            {/* Input */}
            <CardContent className="border-t border-border p-4 pt-4">
              {error && (
                <div className="mb-3 flex items-start justify-between gap-3 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-400">
                  <span>{error}</span>
                  {errorCode === "NO_MODEL" && (
                    <a href="/settings" className="shrink-0 underline underline-offset-2 font-medium">
                      Open Settings
                    </a>
                  )}
                </div>
              )}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  send();
                }}
                className="flex items-center gap-2"
              >
                <input
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder={thinking ? "Waiting for a reply…" : 'e.g. "Create a post about our new feature"'}
                  className="flex-1 h-12 rounded-xl border border-input bg-muted/50 px-4 text-sm focus:outline-none focus:ring-2 focus:ring-gold-500/30 transition-all"
                />
                <MagneticButton strength={0.15}>
                  <Button type="submit" variant="gold" size="icon" className="rounded-xl size-12" disabled={thinking}>
                    <Send className="size-4" />
                  </Button>
                </MagneticButton>
              </form>
              <div className="mt-2 flex items-center justify-between gap-2">
                {model.configured ? (
                  !model.isBuiltin ? (
                    <Badge variant="gold" className="text-[10px] gap-1" title={`Answering with ${model.name} · ${model.modelId}`}>
                      <Sparkles className="size-2.5" />
                      {model.name} · {model.modelId}
                    </Badge>
                  ) : (
                    <span />
                  )
                ) : (
                  <a href="/settings" className="text-[10px] text-amber-500 hover:underline">
                    No model configured — open Settings
                  </a>
                )}
                <span className="text-[10px] text-muted-foreground">
                  Press Enter to send
                </span>
              </div>
            </CardContent>
          </Card>
        </BlurFade>
      </div>
    </div>
  );
}
