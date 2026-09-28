import * as React from "react";

import { cn } from "@/components/lib/utils";
import { Card, CardContent } from "@/components/ui/card";

/**
 * What a screen shows when it has nothing to show.
 *
 * A list with no rows is the most common state a new user reaches, and it is
 * the state most worth designing. Three rules it follows, all of which come
 * from the same thing: an empty list is a question, not a void.
 *
 * **It says what would be here.** "No runs yet" tells a user what they are
 * looking at. A blank table tells them the product is broken.
 *
 * **It says what to do about it.** Where there is a next step, it is given as a
 * link, because the shortest distance between "you have no goals" and "you have
 * a goal" is one click.
 *
 * **It never invents reassurance.** No illustration, no "everything is
 * working". A user with no runs has not succeeded at anything, and a screen
 * that congratulates them for an absence is being cute at their expense.
 */
export function EmptyState({
  title,
  description,
  action,
  icon: Icon,
  className,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  icon?: React.ComponentType<{ className?: string }>;
  className?: string;
}) {
  return (
    <Card className={cn("border-dashed", className)}>
      <CardContent className="flex flex-col items-center justify-center gap-3 py-14 text-center">
        {Icon ? <Icon className="size-8 text-muted-foreground/50" /> : null}
        <div className="space-y-1">
          <p className="font-medium">{title}</p>
          {description ? (
            <p className="mx-auto max-w-md text-sm text-muted-foreground">
              {description}
            </p>
          ) : null}
        </div>
        {action}
      </CardContent>
    </Card>
  );
}

/**
 * A titled section header for a list screen.
 *
 * Separate from the page header so a screen with two lists can give each its
 * own heading, which is also what makes the page's document outline usable —
 * a screen whose two sections are both called "Recent" is navigable only by
 * looking.
 */
export function SectionHeader({
  title,
  description,
  action,
  className,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-end justify-between gap-4", className)}>
      <div className="space-y-1">
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
        {description ? (
          <p className="text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {action}
    </div>
  );
}
