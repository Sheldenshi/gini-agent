"use client";

import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useHindsightBanks, useHindsightUnits } from "@/lib/queries";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import type { HindsightBankView, HindsightRecallView, HindsightReflectView, HindsightUnitView } from "@/lib/view-types";

const NETWORKS = ["all", "world", "experience", "opinion", "observation"] as const;
const UNITS_PAGE_SIZE = 10;

// HindsightPanel renders the Hindsight memory surfaces:
//   - bank profile editor (sliders for skepticism / literalism / empathy / bias)
//   - recall search box (POST /api/memory/recall, channel pills on each hit)
//   - reflect panel (POST /api/memory/reflect, shows response + new opinions)
//   - units browser (filter by network, shows confidence + provenance)
export function HindsightPanel() {
  const banks = useHindsightBanks();
  const [network, setNetwork] = useState<typeof NETWORKS[number]>("all");
  const [visibleCount, setVisibleCount] = useState(UNITS_PAGE_SIZE);
  const units = useHindsightUnits(network);
  const bank = banks.data?.[0];

  // Reset pagination when the user switches network tabs so the new
  // list starts from the top instead of preserving a deep scroll.
  useEffect(() => {
    setVisibleCount(UNITS_PAGE_SIZE);
  }, [network]);

  const allUnits = units.data ?? [];
  const visibleUnits = allUnits.slice(0, visibleCount);
  const remaining = Math.max(0, allUnits.length - visibleUnits.length);

  return (
    <div className="space-y-4">
      <header>
        <h2 className="text-lg font-semibold">Hindsight memory</h2>
        <p className="text-xs text-muted-foreground">
          Four-network memory graph: world, experience, opinion, observation. Auto-populated by the
          retain pipeline as tasks complete.
        </p>
      </header>

      {bank ? <BankProfileEditor bank={bank} /> : <Card><CardContent className="py-6 text-sm text-muted-foreground">No memory bank yet.</CardContent></Card>}

      <RecallSearch />
      <ReflectPanel />

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Memory units</CardTitle>
          <CardDescription className="text-xs">
            Filtered by network. Confidence is shown for opinions; provenance links to the source task when present.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Tabs value={network} onValueChange={(value) => setNetwork(value as typeof network)}>
            <TabsList>
              {NETWORKS.map((value) => (
                <TabsTrigger key={value} value={value} className="capitalize text-xs">{value}</TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          {allUnits.length === 0 ? (
            <p className="py-6 text-center text-xs text-muted-foreground">No units in this network yet.</p>
          ) : (
            <>
              <ul className="space-y-2">
                {visibleUnits.map((unit) => <UnitRow key={unit.id} unit={unit} />)}
              </ul>
              <div className="flex items-center justify-between pt-2 text-xs text-muted-foreground">
                <span>
                  Showing {visibleUnits.length} of {allUnits.length}
                </span>
                {remaining > 0 ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setVisibleCount((count) => count + UNITS_PAGE_SIZE)}
                  >
                    Load {Math.min(UNITS_PAGE_SIZE, remaining)} more
                  </Button>
                ) : visibleUnits.length > UNITS_PAGE_SIZE ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setVisibleCount(UNITS_PAGE_SIZE)}
                  >
                    Show less
                  </Button>
                ) : null}
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function UnitRow({ unit }: { unit: HindsightUnitView }) {
  const taskId = unit.sourceTaskId;
  const entities = Array.isArray(unit.metadata?.entities)
    ? (unit.metadata.entities as { text?: string }[])
        .map((entry) => entry?.text)
        .filter((text): text is string => Boolean(text))
    : [];
  return (
    <li className="rounded border bg-card/50 p-3">
      <div className="flex flex-wrap items-center gap-2 text-[11px] uppercase text-muted-foreground">
        <Badge variant="outline">{unit.network}</Badge>
        {unit.confidence !== null ? (
          <Badge variant="secondary">conf {unit.confidence.toFixed(2)}</Badge>
        ) : null}
        {taskId ? <Badge variant="outline">task {taskId.slice(0, 12)}</Badge> : null}
        {entities.slice(0, 3).map((entity) => (
          <Badge key={entity} variant="outline">{entity}</Badge>
        ))}
        <span className="ml-auto font-mono text-[10px]">{new Date(unit.mentionedAt).toLocaleString()}</span>
      </div>
      <p className="mt-2 text-sm">{unit.text}</p>
    </li>
  );
}

function BankProfileEditor({ bank }: { bank: HindsightBankView }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(bank);

  const update = useMutation({
    mutationFn: (patch: Partial<HindsightBankView>) =>
      api<HindsightBankView>(`/memory/banks/${bank.id}`, { method: "PATCH", body: JSON.stringify(patch) }),
    onSuccess: (next) => {
      setDraft(next);
      queryClient.invalidateQueries({ queryKey: ["memory", "banks"] });
      toast.success("Bank profile updated");
    },
    onError: (error: Error) => toast.error(error.message)
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Bank profile</CardTitle>
        <CardDescription className="text-xs">
          Sliders shape how the reflect pipeline phrases its responses. Bias strength scales the effect.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 md:grid-cols-2">
        <ProfileField
          label="Skepticism"
          value={draft.skepticism}
          min={1}
          max={5}
          onChange={(value) => setDraft({ ...draft, skepticism: value })}
        />
        <ProfileField
          label="Literalism"
          value={draft.literalism}
          min={1}
          max={5}
          onChange={(value) => setDraft({ ...draft, literalism: value })}
        />
        <ProfileField
          label="Empathy"
          value={draft.empathy}
          min={1}
          max={5}
          onChange={(value) => setDraft({ ...draft, empathy: value })}
        />
        <ProfileField
          label="Bias strength"
          value={draft.biasStrength}
          min={0}
          max={1}
          step={0.05}
          onChange={(value) => setDraft({ ...draft, biasStrength: value })}
        />
        <div className="md:col-span-2">
          <Button
            size="sm"
            disabled={update.isPending}
            onClick={() => update.mutate({
              skepticism: draft.skepticism,
              literalism: draft.literalism,
              empathy: draft.empathy,
              biasStrength: draft.biasStrength
            })}
          >
            {update.isPending ? "Saving..." : "Save profile"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function ProfileField({
  label, value, min, max, step = 1, onChange
}: { label: string; value: number; min: number; max: number; step?: number; onChange: (value: number) => void }) {
  return (
    <div>
      <Label className="text-xs">{label}: {value}</Label>
      <Input
        type="range"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </div>
  );
}

function RecallSearch() {
  const [query, setQuery] = useState("");
  const recall = useMutation({
    mutationFn: (text: string) =>
      api<HindsightRecallView>("/memory/recall", { method: "POST", body: JSON.stringify({ query: text }) }),
    onError: (error: Error) => toast.error(error.message)
  });
  const result = recall.data;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Recall</CardTitle>
        <CardDescription className="text-xs">
          Four-channel retrieval (semantic + BM25 + graph + temporal) with reciprocal rank fusion.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex gap-2">
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="What do you remember about..."
            onKeyDown={(event) => {
              if (event.key === "Enter" && query.trim()) recall.mutate(query.trim());
            }}
          />
          <Button disabled={!query.trim() || recall.isPending} onClick={() => recall.mutate(query.trim())}>
            {recall.isPending ? "Recalling..." : "Recall"}
          </Button>
        </div>
        {result ? (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              {result.units.length} units · {result.totalTokens} tokens
            </p>
            {result.units.length === 0 ? (
              <p className="text-xs text-muted-foreground">No matches.</p>
            ) : (
              <ul className="space-y-2">
                {result.units.map((entry) => (
                  <li key={entry.unit.id} className="rounded border bg-card/50 p-3">
                    <div className="flex flex-wrap items-center gap-1 text-[10px]">
                      <Badge variant="outline">{entry.unit.network}</Badge>
                      {entry.channels.map((channel) => (
                        <Badge key={channel} variant="secondary">{channel}</Badge>
                      ))}
                      <span className="ml-auto font-mono text-muted-foreground">score {entry.score.toFixed(3)}</span>
                    </div>
                    <p className="mt-2 text-sm">{entry.unit.text}</p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function ReflectPanel() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const reflect = useMutation({
    mutationFn: (text: string) =>
      api<HindsightReflectView>("/memory/reflect", { method: "POST", body: JSON.stringify({ query: text }) }),
    onError: (error: Error) => toast.error(error.message)
  });
  const result = reflect.data;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm flex items-center justify-between">
          Reflect
          <Button size="sm" variant="outline" onClick={() => setOpen((value) => !value)}>
            {open ? "Hide" : "Show"}
          </Button>
        </CardTitle>
        <CardDescription className="text-xs">
          Profile-conditioned response. New opinions are persisted to the bank.
        </CardDescription>
      </CardHeader>
      {open ? (
        <CardContent className="space-y-3">
          <Textarea
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Ask Gini what it thinks..."
            className="min-h-20"
          />
          <Button disabled={!query.trim() || reflect.isPending} onClick={() => reflect.mutate(query.trim())}>
            {reflect.isPending ? "Reflecting..." : "Reflect"}
          </Button>
          {result ? (
            <div className="space-y-2">
              <Card>
                <CardContent className="py-3 text-sm whitespace-pre-wrap">{result.response}</CardContent>
              </Card>
              {result.opinions.length > 0 ? (
                <div>
                  <p className="text-xs uppercase text-muted-foreground">New opinions</p>
                  <ul className="mt-2 space-y-2">
                    {result.opinions.map((opinion) => (
                      <li key={opinion.id} className="rounded border bg-card/50 p-3 text-sm">
                        {opinion.text}
                        {opinion.confidence !== null ? (
                          <Badge className="ml-2" variant="secondary">conf {opinion.confidence.toFixed(2)}</Badge>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : null}
        </CardContent>
      ) : null}
    </Card>
  );
}
