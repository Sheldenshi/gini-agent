"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

// The /setup page. First-run onboarding for a fresh Gini install: the
// runtime is up (autostart enabled it), the user just landed here from
// the installer's `open http://127.0.0.1:3000/setup`, and they need to
// pick a provider before they can use the app.
//
// On mount we call /api/setup/status. If providerConfigured is true the
// user got here by mistake (or backed into the URL) and we redirect to
// home. Otherwise we show a two-tab form: OpenAI (API key field) or
// Codex (run-this-in-terminal instructions + a Refresh button).

type SetupStatus = {
  ok: true;
  providerConfigured: boolean;
  providers: ("openai" | "codex")[];
  current: string | null;
  message: string;
};

type SetupResult = {
  ok: boolean;
  // The gateway uses plistRefreshNeeded internally to coordinate a
  // detached `gini autostart enable --kind gateway` after a successful
  // POST so the new env survives the next launchd respawn. The browser
  // doesn't act on it directly — the running gateway already has the
  // new key in process.env, so the user's session works immediately —
  // and the response handler redirects before any hint could paint.
  plistRefreshNeeded: boolean;
  error?: string;
};

export default function SetupPage() {
  const router = useRouter();
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [openaiKey, setOpenaiKey] = useState("");
  const [tab, setTab] = useState<"openai" | "codex">("openai");

  const refreshStatus = async (): Promise<SetupStatus | null> => {
    try {
      const next = await api<SetupStatus>("/setup/status");
      setStatus(next);
      setError(null);
      return next;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const next = await refreshStatus();
      if (cancelled) return;
      if (next?.providerConfigured) {
        router.replace("/");
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submitOpenAI = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    const apiKey = openaiKey.trim();
    if (!apiKey) {
      setError("API key is required.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const result = await api<SetupResult>("/setup/provider", {
        method: "POST",
        body: JSON.stringify({ provider: "openai", apiKey })
      });
      if (!result.ok) {
        setError(result.error ?? "Setup failed.");
        return;
      }
      // plistRefreshNeeded is informational only on the client; the
      // gateway handles the actual refresh via the autostart-refresh
      // marker + SIGTERM flow.
      router.replace("/");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  const submitCodex = async () => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await api<SetupResult>("/setup/provider", {
        method: "POST",
        body: JSON.stringify({ provider: "codex" })
      });
      if (!result.ok) {
        setError(result.error ?? "Codex credentials not found. Run `codex --login` and retry.");
        return;
      }
      router.replace("/");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <p className="text-sm text-muted-foreground">Loading setup…</p>
      </div>
    );
  }

  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardTitle>Welcome to Gini</CardTitle>
          <CardDescription>
            Pick a provider and Gini will start using it. You can change this later in Settings.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {status && status.current && status.current !== "echo" ? (
            <p className="text-xs text-muted-foreground">
              Current provider: <span className="font-medium">{status.current}</span> — not yet configured.
            </p>
          ) : null}
          <Tabs value={tab} onValueChange={(v) => setTab(v as "openai" | "codex")}>
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="openai">OpenAI</TabsTrigger>
              <TabsTrigger value="codex">Codex</TabsTrigger>
            </TabsList>

            <TabsContent value="openai" className="pt-4">
              <form className="space-y-3" onSubmit={submitOpenAI}>
                <div className="space-y-2">
                  <Label htmlFor="openai-key">OpenAI API key</Label>
                  <Input
                    id="openai-key"
                    type="password"
                    autoComplete="off"
                    placeholder="sk-…"
                    value={openaiKey}
                    onChange={(e) => setOpenaiKey(e.target.value)}
                    disabled={submitting}
                  />
                  <p className="text-xs text-muted-foreground">
                    Saved to ~/.gini/secrets.env (mode 0600). Not sent anywhere except OpenAI.
                  </p>
                </div>
                {error ? <p className="text-xs text-destructive">{error}</p> : null}
                <Button type="submit" disabled={submitting || !openaiKey.trim()}>
                  {submitting ? "Saving…" : "Save and continue"}
                </Button>
              </form>
            </TabsContent>

            <TabsContent value="codex" className="space-y-3 pt-4">
              <p className="text-sm">
                Codex uses your existing <code className="rounded bg-muted px-1 py-0.5 text-xs">codex --login</code>{" "}
                auth (no API key needed). Run this in your terminal first:
              </p>
              <pre className="rounded-md bg-muted p-3 font-mono text-xs">codex --login</pre>
              <p className="text-xs text-muted-foreground">
                Then click Refresh to detect ~/.codex/auth.json and continue.
              </p>
              {error ? <p className="text-xs text-destructive">{error}</p> : null}
              <div className="flex gap-2">
                <Button onClick={submitCodex} disabled={submitting}>
                  {submitting ? "Checking…" : "Use Codex auth"}
                </Button>
                <Button variant="outline" onClick={() => void refreshStatus()} disabled={submitting}>
                  Refresh
                </Button>
              </div>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  );
}
