import Link from "next/link";
import { History } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EmptyState, SectionHeader } from "@/components/runtime/empty-state";
import { ExecutionBadge } from "@/components/runtime/status-badge";
import { requireSessionUser } from "@/lib/session";
import { listRuns, MAX_LIST_LIMIT } from "@/lib/runtime/queries";
import { relativeTime } from "@/lib/runtime/view";

/**
 * The run list — execution history across every goal.
 *
 * ## Why the cap is a number the reader can see
 *
 * `listRuns` clamps whatever it is given to `MAX_LIST_LIMIT`, and the page says
 * so at the bottom when the clamp actually bit. A list that silently stops at
 * 200 rows reads as "these are all of them", and a user looking for a run from
 * four months ago is told the right answer by omission.
 *
 * There is no pagination here and no "load more". That is a deliberate gap, not
 * an oversight: a cursor needs state that survives a shared link and a back
 * button, and the honest intermediate — a capped list that admits it is capped
 * — is more useful than a page size control that pretends 50 is a natural unit
 * of execution history. It is the first thing to build if the cap turns out to
 * bite, and `clampLimit` is where it would attach.
 */
export default async function RunsPage() {
  const user = await requireSessionUser();
  const runs = await listRuns(user.id, { limit: MAX_LIST_LIMIT });
  const capped = runs.length === MAX_LIST_LIMIT;

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Runs</h1>
        <p className="text-sm text-muted-foreground">
          Every run the Runtime has made for you, newest first.
        </p>
      </header>

      <SectionHeader
        title={`${runs.length} run${runs.length === 1 ? "" : "s"}`}
        action={
          <Button asChild variant="ghost" size="sm">
            <Link href="/runtime">
              Back to Runtime
            </Link>
          </Button>
        }
      />

      {runs.length === 0 ? (
        <EmptyState
          icon={History}
          title="No runs yet"
          description="A run is created each time a goal fires. Nothing has fired for you yet."
          action={
            <Button asChild variant="gold" size="sm">
              <Link href="/goals/new">Create a goal</Link>
            </Button>
          }
        />
      ) : (
        <>
          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Slot</TableHead>
                    <TableHead>Goal</TableHead>
                    <TableHead>State</TableHead>
                    <TableHead className="text-right">Steps</TableHead>
                    <TableHead className="text-right">When</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {runs.map((run) => (
                    <TableRow key={run.id}>
                      <TableCell className="font-mono text-xs whitespace-nowrap">
                        <Link href={`/runs/${run.id}`} className="hover:underline">
                          {run.scheduleSlot}
                        </Link>
                      </TableCell>
                      <TableCell className="max-w-[16rem] truncate">
                        <Link href={`/runs/${run.id}`} className="hover:underline">
                          {run.goalTitle}
                        </Link>
                      </TableCell>
                      <TableCell>
                        <ExecutionBadge state={run.state} />
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {run.stepCount}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-right text-muted-foreground">
                        {relativeTime(run.createdAt)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          {capped ? (
            <p className="text-sm text-muted-foreground">
              Showing the most recent {MAX_LIST_LIMIT}. Older runs are not listed
              here.
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}
