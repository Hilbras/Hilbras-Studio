"use client";

import * as React from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { PlatformIcon } from "@/components/platform-icon";
import { BlurFade } from "@/components/motion/blur-fade";
import { MagneticButton } from "@/components/motion/magnetic-button";
import { Sparkles, Send, Wand2, Loader2 } from "lucide-react";
import { sendReply, type InboxMessage } from "@/app/actions/inbox";
import { processAssistantMessage } from "@/app/actions/ai";

export function InboxClient({
  initialMessages,
}: {
  initialMessages: InboxMessage[];
}) {
  const [messages] = React.useState<InboxMessage[]>(initialMessages);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [reply, setReply] = React.useState("");
  const [sending, setSending] = React.useState(false);
  const [sendResult, setSendResult] = React.useState<{
    success: boolean;
    error?: string;
  } | null>(null);
  const [suggestions, setSuggestions] = React.useState<string[]>([]);
  const [loadingSuggestions, setLoadingSuggestions] = React.useState(false);

  const selected = messages.find((m) => m.id === selectedId);

  const generateSuggestions = async (text: string) => {
    setLoadingSuggestions(true);
    try {
      const result = await processAssistantMessage(
        [],
        `Generate 3 short, friendly reply suggestions for this social media message: "${text}" — each on a new line, no numbering.`
      );
      if (!result.error && result.content) {
        setSuggestions(
          result.content
            .split("\n")
            .filter((l) => l.trim())
            .slice(0, 3)
        );
      }
    } catch {
      // silently fail
    } finally {
      setLoadingSuggestions(false);
    }
  };

  React.useEffect(() => {
    if (selected) {
      setReply("");
      setSendResult(null);
      setSuggestions([]);
      generateSuggestions(selected.text);
    }
  }, [selectedId]);

  const handleSend = async () => {
    if (!reply.trim() || !selected) return;
    setSending(true);
    setSendResult(null);
    try {
      const result = await sendReply(selected.platform, selected.id, reply);
      setSendResult(result);
      if (result.success) {
        setReply("");
      }
    } catch (e: any) {
      setSendResult({ success: false, error: e.message });
    } finally {
      setSending(false);
    }
  };

  const unreadCount = messages.filter((m) => m.unread).length;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
      {/* Message list */}
      <BlurFade delay={0.1} className="lg:col-span-2">
        <Card className="hover:shadow-xl hover:shadow-gold-500/10 transition-shadow duration-300 h-full">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle>Messages</CardTitle>
              <Badge variant="gold">{unreadCount} new</Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-1 p-2 pt-0">
            {messages.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground">
                <Sparkles className="size-8 mx-auto mb-3 text-gold-500/50" />
                <p className="text-sm">No messages yet.</p>
                <p className="text-xs mt-1">
                  Connect your social accounts to see mentions and DMs here.
                </p>
              </div>
            ) : (
              messages.map((m, i) => (
                <motion.button
                  key={m.id}
                  initial={{ opacity: 0, x: -12 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: 0.15 + i * 0.06 }}
                  whileHover={{ x: 3 }}
                  onClick={() => setSelectedId(m.id)}
                  className={`w-full flex gap-3 rounded-xl p-3 text-left transition-colors ${
                    selectedId === m.id
                      ? "bg-gold-500/10 border border-gold-500/20"
                      : "hover:bg-muted/50 border border-transparent"
                  }`}
                >
                  <div className="relative shrink-0">
                    <Avatar>
                      <AvatarFallback className="bg-gradient-to-br from-gold-400 to-gold-600 text-white text-xs font-bold">
                        {m.name[0]}
                      </AvatarFallback>
                    </Avatar>
                    <PlatformIcon
                      platform={m.platform as never}
                      size={14}
                      className="absolute -bottom-0.5 -right-0.5 ring-2 ring-card rounded"
                    />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm font-medium truncate">{m.name}</p>
                      <span className="text-[10px] text-muted-foreground shrink-0">
                        {m.time}
                      </span>
                    </div>
                    <p
                      className={`text-xs truncate mt-0.5 ${
                        m.unread
                          ? "text-foreground font-medium"
                          : "text-muted-foreground"
                      }`}
                    >
                      {m.text}
                    </p>
                  </div>
                  {m.unread && (
                    <span className="w-2 h-2 rounded-full bg-gold-500 mt-2 shrink-0" />
                  )}
                </motion.button>
              ))
            )}
          </CardContent>
        </Card>
      </BlurFade>

      {/* Conversation view */}
      <AnimatePresence mode="wait">
        {selected ? (
          <motion.div
            key={selected.id}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.25 }}
            className="lg:col-span-3"
          >
            <Card className="hover:shadow-xl hover:shadow-gold-500/10 transition-shadow duration-300 h-full flex flex-col">
              <CardHeader className="pb-4 border-b border-border">
                <div className="flex items-center gap-3">
                  <Avatar>
                    <AvatarFallback className="bg-gradient-to-br from-gold-400 to-gold-600 text-white font-bold">
                      {selected.name[0]}
                    </AvatarFallback>
                  </Avatar>
                  <div className="flex-1">
                    <CardTitle className="text-sm">{selected.name}</CardTitle>
                    <CardDescription className="flex items-center gap-1.5 text-xs">
                      <PlatformIcon
                        platform={selected.platform as never}
                        size={12}
                      />
                      {selected.handle}
                    </CardDescription>
                  </div>
                </div>
              </CardHeader>

              <CardContent className="flex-1 py-6 space-y-4 overflow-y-auto">
                <motion.div
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="flex gap-2.5 max-w-[80%]"
                >
                  <div className="rounded-2xl rounded-tl-sm bg-muted px-4 py-3">
                    <p className="text-sm leading-relaxed">{selected.text}</p>
                  </div>
                </motion.div>

                {/* AI suggestions */}
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: 0.3 }}
                  className="space-y-2 pl-2"
                >
                  <p className="text-xs text-muted-foreground flex items-center gap-1.5">
                    <Sparkles className="size-3 text-gold-500" /> AI suggested
                    replies
                  </p>
                  {loadingSuggestions ? (
                    <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
                      <Loader2 className="size-3 animate-spin" /> Generating
                      suggestions…
                    </div>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      {suggestions.map((s, i) => (
                        <motion.button
                          key={i}
                          initial={{ opacity: 0, scale: 0.9 }}
                          animate={{ opacity: 1, scale: 1 }}
                          transition={{ delay: 0.35 + i * 0.08 }}
                          whileHover={{
                            scale: 1.03,
                            borderColor: "var(--color-gold-500)",
                          }}
                          onClick={() => setReply(s)}
                          className="text-xs text-left px-3 py-2 rounded-xl border border-border bg-muted/40 hover:bg-muted/70 transition-colors"
                        >
                          {s}
                        </motion.button>
                      ))}
                    </div>
                  )}
                </motion.div>

                {/* Send result feedback */}
                {sendResult && (
                  <motion.div
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    className={`text-xs px-3 py-2 rounded-lg ${
                      sendResult.success
                        ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                        : "bg-red-500/10 text-red-600 dark:text-red-400"
                    }`}
                  >
                    {sendResult.success
                      ? "Reply sent successfully!"
                      : sendResult.error || "Failed to send reply"}
                  </motion.div>
                )}
              </CardContent>

              <CardContent className="pt-0 pb-6">
                <div className="flex items-center gap-2">
                  <input
                    value={reply}
                    onChange={(e) => setReply(e.target.value)}
                    placeholder="Write a reply…"
                    className="flex-1 h-11 rounded-xl border border-input bg-muted/50 px-4 text-sm focus:outline-none focus:ring-2 focus:ring-gold-500/30 transition-all"
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        handleSend();
                      }
                    }}
                  />
                  <MagneticButton strength={0.15}>
                    <Button
                      variant="gold"
                      size="icon"
                      className="rounded-xl size-11"
                      onClick={handleSend}
                      disabled={sending || !reply.trim()}
                    >
                      {sending ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <Send className="size-4" />
                      )}
                    </Button>
                  </MagneticButton>
                  <Button
                    variant="outline"
                    size="icon"
                    className="rounded-xl size-11"
                    onClick={() => generateSuggestions(selected.text)}
                    disabled={loadingSuggestions}
                  >
                    <Wand2 className="size-4" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          </motion.div>
        ) : (
          <motion.div
            key="empty"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="lg:col-span-3"
          >
            <Card className="h-full min-h-96 flex items-center justify-center">
              <div className="text-center text-muted-foreground">
                <Sparkles className="size-10 mx-auto mb-3 text-gold-500/50" />
                <p className="text-sm">Select a conversation to view it here</p>
              </div>
            </Card>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

