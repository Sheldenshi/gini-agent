import { homedir } from "node:os";

const useColor = process.stdout.isTTY && process.env.TERM !== "dumb" && !process.env.NO_COLOR;

export const COLOR = {
  green: useColor ? "\x1b[32m" : "",
  red: useColor ? "\x1b[31m" : "",
  yellow: useColor ? "\x1b[33m" : "",
  cyan: useColor ? "\x1b[36m" : "",
  dim: useColor ? "\x1b[2m" : "",
  bold: useColor ? "\x1b[1m" : "",
  reset: useColor ? "\x1b[0m" : ""
};

export function step(message: string): void {
  console.log(`${COLOR.green}✓${COLOR.reset} ${message}`);
}

export function info(message: string): void {
  console.log(`${COLOR.dim}•${COLOR.reset} ${message}`);
}

export function warn(message: string): void {
  console.warn(`${COLOR.yellow}⚠${COLOR.reset}  ${message}`);
}

export function fail(message: string): void {
  console.error(`${COLOR.red}✗${COLOR.reset} ${message}`);
}

export function header(message: string): void {
  console.log(`${COLOR.bold}${message}${COLOR.reset}\n`);
}

export function footer(message: string): void {
  console.log(`\n${COLOR.bold}${message}${COLOR.reset}`);
}

export function tildify(path: string): string {
  const home = homedir();
  if (path === home) return "~";
  if (path.startsWith(home + "/")) return "~" + path.slice(home.length);
  return path;
}
