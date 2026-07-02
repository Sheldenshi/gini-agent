// Localhost runtime HTTP helpers used by every command module.
import type { RuntimeConfig } from "../types";

export function url(config: RuntimeConfig): string {
  return `http://127.0.0.1:${config.port}`;
}

export function auth(config: RuntimeConfig): Record<string, string> {
  return { authorization: `Bearer ${config.token}` };
}

export async function api(config: RuntimeConfig, path: string, options: RequestInit = {}) {
  return apiWithToken(config, config.token, path, options);
}

export async function apiWithToken(
  config: RuntimeConfig,
  token: string,
  path: string,
  options: RequestInit = {}
) {
  const response = await fetch(`${url(config)}${path}`, {
    ...options,
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...(options.headers ?? {}) }
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`);
  return value;
}

export async function publicApi(config: RuntimeConfig, path: string, options: RequestInit = {}) {
  const response = await fetch(`${url(config)}${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) }
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`);
  return value;
}
