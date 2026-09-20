"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Send } from "lucide-react";

import { Button } from "@/components/ui/button";
import { publishDuePostsAction } from "@/app/actions/posts";

/**
 * Publish everything that is due right now.
 *
 * Vercel Cron can only run once a day on the Hobby plan, so a post scheduled for
 * 14:30 would otherwise wait for the next daily run. This runs the same scheduled
 * post runner, scoped to the signed-in user, on demand.
 */
export function PublishDueButton() {
  const router = useRouter();
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [isError, setIsError] = useState(false);

  const run = async () => {
    setRunning(true);
    setMessage(null);
    try {
      const result = await publishDuePostsAction();

      if (result.error) {
        setIsError(true);
        setMessage(result.error);
      } else if (!result.processed) {
        setIsError(false);
        setMessage("Nothing due right now");
      } else {
        setIsError(false);
        setMessage(
          `Published ${result.published} of ${result.processed}${
            result.failed ? ` — ${result.failed} failed` : ""
          }`
        );
      }

      router.refresh();
    } catch (e) {
      setIsError(true);
      setMessage(e instanceof Error ? e.message : "Publish failed");
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="flex items-center gap-2">
      <Button
        variant="outline"
        size="sm"
        className="gap-1 rounded-xl"
        disabled={running}
        onClick={run}
      >
        {running ? (
          <Loader2 className="size-3 animate-spin" />
        ) : (
          <Send className="size-3" />
        )}
        Publish due now
      </Button>
      {message && (
        <span
          className={`text-xs ${isError ? "text-red-500" : "text-muted-foreground"}`}
        >
          {message}
        </span>
      )}
    </div>
  );
}