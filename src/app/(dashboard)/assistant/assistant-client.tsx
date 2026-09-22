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
import { Sparkles, Send, Bot, User, Wand2, Calendar, BarChart3 } from "lucide-react";
import type { ActiveModelInfo } from "@/lib/ai";

interface ChatMessage {
  id: string;
  role: "user" | "ai";
  text: string;
}

// Convert to AI service format
function toAiMessages(messages: ChatMessage[]) {
  return messages.map((m) => ({ role: m.role as "user" | "assistant", content: m.text }));
}

const QUICK_PROMPTS = [
  { icon: Wand2, label: "Draft a launch post for all platforms" },
  { icon: Calendar, label: "What should I post this week?" },
  { icon: BarChart3, label: "How did my content perform?" },
];

/** Only the last N turns go to the model — keeps requests bounded. */
const MAX_HISTORY = 30;

const WELCOME: ChatMessage = {
  id: "0",
  role: "ai",
  text: "Hi! I'm your social media copilot. Ask me to draft posts, analyze performance, or plan your week.",
};

export function AssistantClient({ model }: { model: ActiveModelInfo }) {
  const [messages, setMessages] = React.useState<ChatMessage[]>([WELCOME]);
  const [input, setInput] = React.useState("");
  const [thinking, setThinking] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [errorCode, setErrorCode] = React.useState<string | null>(null);
  const scrollRef = React.useRef<HTMLDivElement>(null);

  // Keep the newest token in view while it streams in.
  React.useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, thinking]);

  const send = async (text?: string) => {
    const msg = (text ?? input).trim();
    if (!msg || thinking) return;

    const userMsg: ChatMessage = { id: `u${Date.now()}`, role: "user", text: msg };
    const aiMsgId = `a${Date.now()}`;
    const history = [...messages, userMsg];

    setMessages([...history, { id: aiMsgId, role: "ai", text: "" }]);
    setInput("");
    setThinking(true);
    setError(null);
    setErrorCode(null);

    try {
      const res = await fetch("/api/assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: toAiMessages(history).slice(-MAX_HISTORY) }),
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
    } catch (err) {
      const message = err instanceof Error ? err.message : "Something went wrong.";
      setError(message);
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
        >
          <h1 className="text-2xl font-bold tracking-tight">
            <WordReveal text="AI Assistant" />
          </h1>
          <p className="text-sm text-muted-foreground">
            <WordReveal text="Your copilot for everything social." delay={0.15} />
          </p>
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
                  <Badge variant="gold" className="text-[10px] gap-1" title={`Answering with ${model.name} · ${model.modelId}`}>
                    <Sparkles className="size-2.5" />
                    {model.name} · {model.modelId}
                  </Badge>
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
