"use client";

// Focused dialog for pasting the secret fields of a provider that carries a
// credential template (e.g. google-oauth-desktop). Renders one input per
// provider field and submits an explicit create-connector body built from the
// provider's credentialTemplate, so a user with a pre-existing OAuth client can
// plant it without the Cloud Console walkthrough. Stays a controlled component
// (open/onOpenChange owned by the caller) so the call site decides when to
// surface it.

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ProviderDescriptor } from "@/lib/queries";
import type { CreateConnectorBody } from "@/components/AddConnectorDialog";

interface ManualCredentialDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  provider: ProviderDescriptor | null; // expected to have credentialTemplate
  onSubmit: (body: CreateConnectorBody) => void;
  pending?: boolean;
}

export function ManualCredentialDialog({
  open,
  onOpenChange,
  provider,
  onSubmit,
  pending = false
}: ManualCredentialDialogProps) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setValues({});
      setError(null);
    }
  }, [open]);

  // Defensive: the caller only opens this for providers that carry a template,
  // but bail out if that invariant is broken so submit never builds a bad body.
  if (!provider?.credentialTemplate) return null;

  const submit = () => {
    setError(null);
    for (const field of provider.fields) {
      if (field.required && !(values[field.name] ?? "").trim()) {
        setError(`${field.label} is required.`);
        return;
      }
    }
    const tmpl = provider.credentialTemplate!;
    const secrets: Record<string, string> = {};
    for (const f of provider.fields) {
      const v = (values[f.name] ?? "").trim();
      if (v) secrets[f.name] = v;
    }
    onSubmit({
      provider: provider.id,
      name: tmpl.name,
      type: tmpl.type,
      secrets,
      metadata: tmpl.envMap ? { envMap: tmpl.envMap } : undefined
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Connect {provider.label}</DialogTitle>
          <DialogDescription>
            {provider.description} The values are stored encrypted server-side and never shown to the agent.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {provider.fields.map((field) => (
            <div key={field.name} className="space-y-1">
              <Label htmlFor={`manual-${field.name}`}>{field.label}{field.required ? " *" : ""}</Label>
              <Input
                id={`manual-${field.name}`}
                type={field.secret ? "password" : "text"}
                value={values[field.name] ?? ""}
                onChange={(e) => {
                  const next = e.target.value;
                  setValues((prev) => ({ ...prev, [field.name]: next }));
                  setError(null);
                }}
                placeholder={field.placeholder}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                data-1p-ignore="true"
                data-lpignore="true"
                data-form-type="other"
                className={field.secret ? "font-mono" : undefined}
              />
              {field.description ? (
                <p className="text-[11px] text-muted-foreground">{field.description}</p>
              ) : null}
            </div>
          ))}
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button onClick={submit} disabled={pending}>
            {pending ? "Adding…" : "Add"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
