"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // Surface to the runtime audit by way of console; the browser console is
    // captured by the manual smoke procedure.
    console.error(error);
  }, [error]);

  return (
    <div className="flex flex-1 items-center justify-center bg-background p-6 text-foreground">
      <Card className="max-w-md">
        <CardHeader>
          <CardTitle className="text-base">Something went wrong</CardTitle>
          <CardDescription>The page hit an unexpected error. Try again or check the runtime logs.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <pre className="overflow-x-auto rounded-md border border-border bg-card/50 p-3 font-mono text-[11px] text-muted-foreground">
            {error.message}
            {error.digest ? `\n\ndigest: ${error.digest}` : ""}
          </pre>
          <Button size="sm" onClick={reset}>Try again</Button>
        </CardContent>
      </Card>
    </div>
  );
}
