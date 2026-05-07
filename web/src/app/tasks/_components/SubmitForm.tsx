"use client";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

export function SubmitForm({
  input,
  pending,
  onChange,
  onSubmit
}: {
  input: string;
  pending: boolean;
  onChange: (value: string) => void;
  onSubmit: () => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">New task</CardTitle>
        <CardDescription>e.g. read README.md, write x.txt :: hello</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        <Textarea
          value={input}
          onChange={(event) => onChange(event.target.value)}
          placeholder="Ask Gini to do something"
          className="min-h-24"
        />
        <Button
          disabled={pending || !input.trim()}
          onClick={onSubmit}
          className="w-full"
        >
          {pending ? "Submitting…" : "Submit task"}
        </Button>
      </CardContent>
    </Card>
  );
}
