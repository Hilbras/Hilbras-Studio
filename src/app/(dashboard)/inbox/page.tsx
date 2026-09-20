import { Sparkles } from "lucide-react";
import { GradientMesh } from "@/components/motion/gradient-mesh";
import { WordReveal } from "@/components/motion/word-reveal";
import { getInboxMessages } from "@/app/actions/inbox";
import { InboxClient } from "./inbox-client";

export default async function InboxPage() {
  const messages = await getInboxMessages();

  return (
    <div className="space-y-6 relative">
      <GradientMesh />

      <div className="relative z-10">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            <WordReveal text="Unified Inbox" />
          </h1>
          <p className="text-sm text-muted-foreground">
            <WordReveal
              text="Comments, mentions and DMs across every platform."
              delay={0.15}
            />
          </p>
        </div>

        <div className="mt-6">
          <InboxClient initialMessages={messages} />
        </div>
      </div>
    </div>
  );
}
