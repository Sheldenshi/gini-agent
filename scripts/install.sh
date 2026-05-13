#!/usr/bin/env bash
set -euo pipefail

REPO_URL="https://github.com/Lilac-Labs/gini-agent"
RUNTIME_DIR="$HOME/.gini/runtime"
BIN_DIR="$HOME/.local/bin"
WRAPPER_PATH="$BIN_DIR/gini"
DEFAULT_INSTANCE="default"
PATH_MANUAL=0
SETUP_RAN=0

LOCAL_MODE=0
LOCAL_REPO=""

usage() {
  cat <<USAGE
Usage: install.sh [--local[=PATH]]

  (no flag)         Install from $REPO_URL (default).
  --local           Install from the local repo containing this script.
  --local=PATH      Install from PATH (must be a gini-agent git checkout).

USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --local) LOCAL_MODE=1; LOCAL_REPO="$(cd "$(dirname "$0")/.." && pwd)"; LOCAL_REPO="${LOCAL_REPO%/}" ;;
    --local=*) LOCAL_MODE=1; LOCAL_REPO="${1#--local=}"; LOCAL_REPO="${LOCAL_REPO%/}" ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'unknown flag: %s\n' "$1" >&2; usage >&2; exit 1 ;;
  esac
  shift
done

if [ -t 1 ] && command -v tput >/dev/null 2>&1 && [ -z "${NO_COLOR:-}" ]; then
  C_GREEN="$(tput setaf 2)"
  C_RED="$(tput setaf 1)"
  C_DIM="$(tput dim)"
  C_BOLD="$(tput bold)"
  C_RESET="$(tput sgr0)"
else
  C_GREEN=""; C_RED=""; C_DIM=""; C_BOLD=""; C_RESET=""
fi

step() { printf '%s✓%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
info() { printf '%s•%s %s\n' "$C_DIM" "$C_RESET" "$*"; }
err()  { printf '%s✗%s %s\n' "$C_RED" "$C_RESET" "$*" >&2; }

# Run a command quietly: show only a checkmark on success, dump captured output on failure.
# Usage: quiet "Step label" cmd args...
quiet() {
  local label="$1"
  shift
  local logfile
  logfile="$(mktemp)"
  if "$@" >"$logfile" 2>&1; then
    step "$label"
    rm -f "$logfile"
  else
    local rc=$?
    err "$label failed (exit $rc)"
    printf '%s\n' "$C_DIM----- output -----$C_RESET" >&2
    cat "$logfile" >&2
    printf '%s\n' "$C_DIM------------------$C_RESET" >&2
    rm -f "$logfile"
    exit $rc
  fi
}

verify_local_repo() {
  if [ ! -e "$LOCAL_REPO/.git" ] || [ ! -f "$LOCAL_REPO/package.json" ]; then
    err "$LOCAL_REPO does not look like a gini-agent checkout."
    exit 1
  fi
  if ! grep -q '"name": "gini-agent"' "$LOCAL_REPO/package.json"; then
    err "$LOCAL_REPO/package.json does not declare name \"gini-agent\"."
    exit 1
  fi
}

detect_os() {
  if [ "$(uname -o 2>/dev/null || true)" = "Android" ]; then
    err "Android / Termux is not supported by gini-agent"
    exit 1
  fi
  case "$(uname -s)" in
    Darwin) printf 'darwin' ;;
    Linux) printf 'linux' ;;
    *) err "unsupported OS: $(uname -s) (supported: macOS, Linux, WSL2)"; exit 1 ;;
  esac
}

detect_arch() {
  case "$(uname -m)" in
    arm64|aarch64) printf 'arm64' ;;
    x86_64|amd64) printf 'x86_64' ;;
    *) err "unsupported architecture: $(uname -m)"; exit 1 ;;
  esac
}

detect_shell_rc() {
  local shell_name=""
  [ -n "${SHELL:-}" ] && shell_name="$(basename "$SHELL")"
  case "$shell_name" in
    zsh)
      if [ -n "${ZDOTDIR:-}" ] && [ -d "$ZDOTDIR" ] && [ -w "$ZDOTDIR" ]; then
        printf '%s/.zshrc' "$ZDOTDIR"
      else
        printf '%s/.zshrc' "$HOME"
      fi
      ;;
    bash)
      if [ "$OS" = "darwin" ]; then printf '%s/.bash_profile' "$HOME"
      else printf '%s/.bashrc' "$HOME"; fi
      ;;
    fish) printf '%s/.config/fish/config.fish' "$HOME" ;;
    *)
      if [ "$OS" = "darwin" ]; then printf '%s/.zshrc' "$HOME"
      else printf '%s/.bashrc' "$HOME"; fi
      ;;
  esac
}

detect_shell_name() {
  local shell_name=""
  [ -n "${SHELL:-}" ] && shell_name="$(basename "$SHELL")"
  printf '%s' "$shell_name"
}

ensure_bun() {
  if command -v bun >/dev/null 2>&1; then
    step "Bun ready ($(bun --version))"
    return
  fi
  quiet "Bun installed" bash -c "curl -fsSL https://bun.sh/install | bash"
  export PATH="${BUN_INSTALL:-$HOME/.bun}/bin:$PATH"
  if ! command -v bun >/dev/null 2>&1; then
    err "bun did not land on PATH. Open a new shell and re-run the installer."
    exit 1
  fi
}

fetch_runtime() {
  mkdir -p "$HOME/.gini"

  local expected_origin
  if [ "$LOCAL_MODE" = "1" ]; then
    expected_origin="$LOCAL_REPO"
  else
    expected_origin="$REPO_URL"
  fi

  if [ -d "$RUNTIME_DIR/.git" ]; then
    local existing_origin
    existing_origin="$(git -C "$RUNTIME_DIR" remote get-url origin 2>/dev/null || true)"
    if [ -z "$existing_origin" ] || [ "${existing_origin%.git}" != "${expected_origin%.git}" ]; then
      err "$RUNTIME_DIR is already installed from a different source ($existing_origin)."
      err "Run 'gini uninstall --purge' first, or move that directory aside."
      exit 1
    fi
    if [ "$LOCAL_MODE" = "1" ]; then
      quiet "Source refreshed" bash -c "git -C '$RUNTIME_DIR' fetch origin && git -C '$RUNTIME_DIR' reset --hard origin/HEAD"
    else
      quiet "Source updated" bash -c "git -C '$RUNTIME_DIR' fetch origin && git -C '$RUNTIME_DIR' reset --hard origin/main"
    fi
  elif [ -d "$RUNTIME_DIR" ] && [ -n "$(ls -A "$RUNTIME_DIR" 2>/dev/null || true)" ]; then
    err "$RUNTIME_DIR exists but is not a git checkout. Remove or move it aside and re-run."
    exit 1
  else
    if [ "$LOCAL_MODE" = "1" ]; then
      quiet "Source cloned" git clone --local "$LOCAL_REPO" "$RUNTIME_DIR"
    else
      quiet "Source downloaded" git clone "$REPO_URL" "$RUNTIME_DIR"
    fi
  fi
}

install_deps() {
  quiet "Dependencies installed" bash -c "cd '$RUNTIME_DIR' && bun install"
  if [ -f "$RUNTIME_DIR/web/package.json" ]; then
    quiet "Web app installed" bash -c "cd '$RUNTIME_DIR/web' && bun install"
  fi
}

write_wrapper() {
  mkdir -p "$BIN_DIR"
  if [ -e "$WRAPPER_PATH" ] && ! grep -Fq 'gini-agent-installer-managed' "$WRAPPER_PATH" 2>/dev/null; then
    err "$WRAPPER_PATH already exists and is not managed by this installer."
    err "Remove or rename it (e.g. mv \"$WRAPPER_PATH\" \"$WRAPPER_PATH.bak\") and re-run."
    exit 1
  fi
  cat >"$WRAPPER_PATH" <<'WRAPPER'
#!/usr/bin/env bash
# gini-agent-installer-managed
set -euo pipefail
if [ -f "$HOME/.gini/secrets.env" ]; then
  set +e
  set -a
  . "$HOME/.gini/secrets.env" || printf 'gini: warning — failed to source ~/.gini/secrets.env, continuing without it\n' >&2
  set +a
  set -e
fi
export GINI_INSTANCE="${GINI_INSTANCE:-default}"
cd "$HOME/.gini/runtime"
exec bun run gini "$@"
WRAPPER
  chmod +x "$WRAPPER_PATH"
  step "Wrapper ready"
}

update_path() {
  local rc_file shell_name path_line
  rc_file="$(detect_shell_rc)"
  shell_name="$(detect_shell_name)"

  if [ "$shell_name" = "fish" ]; then
    path_line='fish_add_path "$HOME/.local/bin"'
    mkdir -p "$(dirname "$rc_file")" 2>/dev/null || true
  else
    path_line='export PATH="$HOME/.local/bin:$PATH"'
  fi

  if [ -f "$rc_file" ] && grep -Eq '^[[:space:]]*[^#].*\.local/bin' "$rc_file"; then
    step "PATH already configured"
    return 0
  fi

  if [ -e "$rc_file" ] && [ ! -w "$rc_file" ]; then
    err "$rc_file is not writable; add this line manually:"
    err "  $path_line"
    PATH_MANUAL=1
    return 0
  fi
  if [ ! -e "$rc_file" ]; then
    local rc_dir
    rc_dir="$(dirname "$rc_file")"
    if [ ! -w "$rc_dir" ] && [ ! -d "$rc_dir" ]; then
      err "$rc_dir does not exist and cannot be created; add this line manually:"
      err "  $path_line"
      PATH_MANUAL=1
      return 0
    fi
  fi

  {
    printf '\n# Added by gini-agent installer\n'
    printf '%s\n' "$path_line"
  } >>"$rc_file" 2>/dev/null || {
    err "could not write $rc_file; add this line manually:"
    err "  $path_line"
    PATH_MANUAL=1
    return 0
  }
  step "PATH configured"
}

initialize_instance() {
  quiet "Initialized" bash -c "cd '$RUNTIME_DIR' && GINI_INSTANCE='$DEFAULT_INSTANCE' bun run gini install"
}

run_setup() {
  # Setup is interactive — needs full stdio for the API-key prompt. Only
  # run when both stdin and stdout are TTYs; the curl|bash piped path
  # (stdin not a TTY) skips this and print_done points users at the
  # `gini setup` command they can run later.
  if [ -t 0 ] && [ -t 1 ]; then
    printf '\n'
    if (cd "$RUNTIME_DIR" && GINI_INSTANCE="$DEFAULT_INSTANCE" bun run gini setup); then
      SETUP_RAN=1
    else
      err "gini setup did not complete. Run 'gini setup' later to finish."
    fi
  fi
}

print_done() {
  local path_ready=0
  case ":$PATH:" in
    *":$BIN_DIR:"*) path_ready=1 ;;
  esac

  if [ "$LOCAL_MODE" = "1" ]; then
    printf '\n%sgini-agent installed%s %s(local: %s)%s\n\n' "$C_BOLD" "$C_RESET" "$C_DIM" "$LOCAL_REPO" "$C_RESET"
  else
    printf '\n%sgini-agent installed.%s\n\n' "$C_BOLD" "$C_RESET"
  fi

  # If setup ran during install, point at `gini start` directly. Otherwise
  # list the two commands the user needs to run, each on its own line so
  # they read as commands, not prose.
  print_next_commands() {
    if [ "$SETUP_RAN" = "1" ]; then
      printf '    gini start\n'
    else
      printf '    gini setup\n'
      printf '    gini start\n'
    fi
  }

  if [ "$PATH_MANUAL" = "1" ]; then
    info "Add \$HOME/.local/bin to your PATH (see the message above), then run:"
    print_next_commands
    printf '\n'
  elif [ "$path_ready" = "0" ]; then
    info "Open a new terminal, then run:"
    print_next_commands
    printf '\n'
  else
    if [ "$SETUP_RAN" = "1" ]; then
      printf 'Run %sgini start%s.' "$C_BOLD" "$C_RESET"
    else
      printf 'Run %sgini setup%s, then %sgini start%s.' "$C_BOLD" "$C_RESET" "$C_BOLD" "$C_RESET"
    fi
    if [ "$LOCAL_MODE" = "1" ]; then
      printf ' After committing changes in %s, run %sgini update%s to re-sync.' "$LOCAL_REPO" "$C_BOLD" "$C_RESET"
    fi
    printf '\n\n'
  fi
}

main() {
  if [ "$LOCAL_MODE" = "1" ]; then
    verify_local_repo
  fi
  OS="$(detect_os)"
  ARCH="$(detect_arch)"
  if [ "$LOCAL_MODE" = "1" ]; then
    printf '%sInstalling gini-agent%s %s(%s/%s, local source)%s\n\n' "$C_BOLD" "$C_RESET" "$C_DIM" "$OS" "$ARCH" "$C_RESET"
  else
    printf '%sInstalling gini-agent%s %s(%s/%s)%s\n\n' "$C_BOLD" "$C_RESET" "$C_DIM" "$OS" "$ARCH" "$C_RESET"
  fi

  ensure_bun
  fetch_runtime
  install_deps
  write_wrapper
  update_path
  initialize_instance
  run_setup
  print_done
}

main "$@"
