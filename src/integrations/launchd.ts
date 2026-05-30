// macOS launchd integration primitives.
//
// This module owns the label / path / service-target derivation for our
// per-instance LaunchAgents and the thin shellouts to `launchctl`. It
// deliberately does NOT know anything about the plist contents, the web
// shim, or how the gateway/web specs are resolved — that's
// src/cli/autostart.ts's job.
//
// The split lets src/runtime/* (e.g. autostart-refresh.ts) import the
// label/path helpers without pulling in CLI-flavored code. Runtime
// modules importing from src/cli/* would have been a layering inversion
// (runtime is the upstream surface; CLI is a client of it).
//
// Re-exported from src/cli/autostart.ts as well so existing call sites
// in tests and CLI commands keep working without churn.

import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Instance } from "../types";

export const LABEL_PREFIX = "ai.lilaclabs.gini";

// Value baked into the plist's EnvironmentVariables (GINI_SUPERVISOR) so a
// launchd-spawned runtime/web/watchdog can recognize at runtime that it is
// under launchd supervision. The foreground / `gini run` / `gini start`
// paths never set it.
export const GINI_SUPERVISOR_VALUE = "launchd";

// Read whether the current process is running under launchd supervision.
// Returns "launchd" only when the env carries our explicit marker (set in
// the plist by resolveLaunchSpecPair); foreground/conductor/tmux runs leave
// it unset and get null. Callers branch on this to choose launchd-native
// behavior (bootout as stop, KeepAlive respawn after self-SIGTERM) vs the
// foreground process-tree behavior.
export function supervisor(): "launchd" | null {
  return process.env.GINI_SUPERVISOR === GINI_SUPERVISOR_VALUE ? "launchd" : null;
}

// Older releases shipped under different label prefixes. `enable()` boots
// out and removes any plists registered under these so an upgrade is clean
// (no orphan launchd jobs, no plist files left in ~/Library/LaunchAgents/).
// Add new entries here — never remove — so users who skip releases still
// migrate correctly. Each prefix is matched both for the older
// single-plist label (`<prefix>.<instance>`) and the current split pair
// (`<prefix>.<instance>.gateway` / `<prefix>.<instance>.web`).
export const LEGACY_LABEL_PREFIXES: readonly string[] = ["ai.lilac.gini"];

// LaunchAgent crashloop cap: bounds how aggressively launchd respawns a
// crashing service. 10s keeps a crashloop from melting CPU without making
// clean-stop recovery painfully slow.
export const THROTTLE_INTERVAL_SECONDS = 10;

export type PlistKind = "gateway" | "web" | "watchdog";

// Returns every legacy label/plist-path pair that may exist on disk for
// this instance, across all known prior label prefixes and both the
// single-plist and split-pair shapes. Used by `enable()` to clean up
// before bootstrapping under the current LABEL_PREFIX.
export interface LegacyHandle {
  label: string;
  plistPath: string;
  serviceTarget: string;
}
export function legacyHandlesFor(instance: Instance): LegacyHandle[] {
  const home = process.env.HOME || homedir();
  const dom = guiDomain();
  const handles: LegacyHandle[] = [];
  for (const prefix of LEGACY_LABEL_PREFIXES) {
    for (const suffix of ["", ".gateway", ".web"]) {
      const label = `${prefix}.${instance}${suffix}`;
      handles.push({
        label,
        plistPath: join(home, "Library", "LaunchAgents", `${label}.plist`),
        serviceTarget: `${dom}/${label}`
      });
    }
  }
  return handles;
}

// The single-plist label `<prefix>.<instance>` from before the
// gateway/web split. `labelFor()` keeps returning this for callers
// that still want a single instance handle (e.g. internal logging,
// label tests). New code that distinguishes the gateway/web pair
// should use `labelForKind`.
export function labelFor(instance: Instance): string {
  return `${LABEL_PREFIX}.${instance}`;
}

export function labelForKind(instance: Instance, kind: PlistKind): string {
  return `${LABEL_PREFIX}.${instance}.${kind}`;
}

export function plistPathFor(instance: Instance, kind?: PlistKind): string {
  const home = process.env.HOME || homedir();
  const label = kind ? labelForKind(instance, kind) : labelFor(instance);
  return join(home, "Library", "LaunchAgents", `${label}.plist`);
}

// Returns the "gui/<uid>" service target launchctl understands. The uid is
// the current effective user. We read it from process.getuid because that's
// what the installed wrapper's domain will be at runtime; reading USER from
// the env can desync after `su` / sudo.
export function guiDomain(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  return `gui/${uid}`;
}

export function serviceTarget(instance: Instance, kind?: PlistKind): string {
  const label = kind ? labelForKind(instance, kind) : labelFor(instance);
  return `${guiDomain()}/${label}`;
}

export interface LaunchctlResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  status: number | null;
}

function runLaunchctl(args: string[]): LaunchctlResult {
  const res = spawnSync("launchctl", args, { encoding: "utf8" });
  return {
    ok: res.status === 0,
    stdout: (res.stdout ?? "").toString(),
    stderr: (res.stderr ?? "").toString(),
    status: res.status ?? null
  };
}

// Probe whether launchctl knows the service. `launchctl print` returns
// non-zero when the label isn't loaded; we treat that as "not loaded".
export function isLoaded(instance: Instance, kind?: PlistKind): boolean {
  const res = runLaunchctl(["print", serviceTarget(instance, kind)]);
  return res.ok;
}

// Read the live PID launchctl thinks the service is running as. Returns
// null if launchctl doesn't know about it OR the service is registered
// but not currently running (e.g. crashed inside ThrottleInterval). Used
// for status output.
export function loadedPid(instance: Instance, kind?: PlistKind): number | null {
  const res = runLaunchctl(["print", serviceTarget(instance, kind)]);
  if (!res.ok) return null;
  // `launchctl print` output includes a `pid = NNN` line when running.
  // Format is stable across macOS 11+.
  const match = res.stdout.match(/^\s*pid\s*=\s*(\d+)/m);
  return match && match[1] ? Number(match[1]) : null;
}

// Read the last exit signal/status if launchctl recorded one. Useful for
// telling the user "service was running but exited with 1" in `status`.
export function loadedLastExitStatus(instance: Instance, kind?: PlistKind): string | null {
  const res = runLaunchctl(["print", serviceTarget(instance, kind)]);
  if (!res.ok) return null;
  const match = res.stdout.match(/^\s*last exit code\s*=\s*(.+)$/m);
  return match && match[1] ? match[1].trim() : null;
}

export function bootstrap(_instance: Instance, plistPath: string): LaunchctlResult {
  return runLaunchctl(["bootstrap", guiDomain(), plistPath]);
}

export function bootout(instance: Instance, kind?: PlistKind): LaunchctlResult {
  return runLaunchctl(["bootout", serviceTarget(instance, kind)]);
}

// Bootout a specific service target string (e.g. a legacy label from a
// prior LABEL_PREFIX). Lets the upgrade path tear down old registrations
// without going through serviceTarget(), which builds against the
// current prefix.
export function bootoutTarget(target: string): LaunchctlResult {
  return runLaunchctl(["bootout", target]);
}

export function isLoadedTarget(target: string): boolean {
  const res = runLaunchctl(["print", target]);
  return res.ok;
}

export function kickstart(instance: Instance, kind?: PlistKind): LaunchctlResult {
  // `kickstart -k` forces a stop+start, used by `autostart enable` when the
  // service is already loaded so an updated plist takes effect immediately.
  return runLaunchctl(["kickstart", "-k", serviceTarget(instance, kind)]);
}

export function platformIsSupported(): boolean {
  return process.platform === "darwin";
}

export function unsupportedPlatformMessage(): string {
  return `gini autostart is macOS-only in v1 (current platform: ${process.platform}). ` +
    `Linux systemd --user parity is a follow-up.`;
}
