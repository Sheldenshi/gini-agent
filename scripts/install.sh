#!/usr/bin/env bash
set -euo pipefail

REPO_URL="https://github.com/Lilac-Labs/gini-agent"
RUNTIME_DIR="$HOME/.gini/runtime"
BIN_DIR="$HOME/.local/bin"
WRAPPER_PATH="$BIN_DIR/gini"
DEFAULT_INSTANCE="home"

log() {
  printf '[gini-install] %s\n' "$*"
}

err() {
  printf '[gini-install] error: %s\n' "$*" >&2
}

detect_os() {
  local uname_s
  uname_s="$(uname -s)"
  case "$uname_s" in
    Darwin) printf 'darwin' ;;
    Linux) printf 'linux' ;;
    *)
      err "unsupported OS: $uname_s"
      err "supported: macOS (darwin), Linux, WSL2"
      exit 1
      ;;
  esac
}

detect_arch() {
  local uname_m
  uname_m="$(uname -m)"
  case "$uname_m" in
    arm64|aarch64) printf 'arm64' ;;
    x86_64|amd64) printf 'x86_64' ;;
    *)
      err "unsupported architecture: $uname_m"
      err "supported: arm64, x86_64"
      exit 1
      ;;
  esac
}

detect_shell_rc() {
  local shell_name=""
  if [ -n "${SHELL:-}" ]; then
    shell_name="$(basename "$SHELL")"
  fi
  case "$shell_name" in
    zsh) printf '%s/.zshrc' "$HOME" ;;
    bash)
      if [ "$OS" = "darwin" ]; then
        printf '%s/.bash_profile' "$HOME"
      else
        printf '%s/.bashrc' "$HOME"
      fi
      ;;
    *)
      if [ "$OS" = "darwin" ]; then
        printf '%s/.zshrc' "$HOME"
      else
        printf '%s/.bashrc' "$HOME"
      fi
      ;;
  esac
}

ensure_bun() {
  if command -v bun >/dev/null 2>&1; then
    log "bun already installed: $(bun --version)"
    return
  fi

  log "bun not found; installing via https://bun.sh/install"
  curl -fsSL https://bun.sh/install | bash

  if [ -s "$HOME/.bun/_bun" ]; then
    # shellcheck disable=SC1091
    . "$HOME/.bun/_bun"
  fi
  if [ -s "$HOME/.bun/env" ]; then
    # shellcheck disable=SC1091
    . "$HOME/.bun/env"
  fi

  if ! command -v bun >/dev/null 2>&1; then
    if [ -x "$HOME/.bun/bin/bun" ]; then
      export PATH="$HOME/.bun/bin:$PATH"
    fi
  fi

  if ! command -v bun >/dev/null 2>&1; then
    err "bun installation did not put bun on PATH"
    err "try opening a new shell and re-running this installer"
    exit 1
  fi

  log "bun installed: $(bun --version)"
}

fetch_runtime() {
  mkdir -p "$HOME/.gini"
  if [ -d "$RUNTIME_DIR/.git" ]; then
    log "updating existing runtime at $RUNTIME_DIR"
    git -C "$RUNTIME_DIR" fetch origin
    git -C "$RUNTIME_DIR" reset --hard origin/main
  else
    log "cloning $REPO_URL into $RUNTIME_DIR"
    git clone "$REPO_URL" "$RUNTIME_DIR"
  fi
}

install_deps() {
  log "installing runtime dependencies via bun install"
  (cd "$RUNTIME_DIR" && bun install)
}

write_wrapper() {
  mkdir -p "$BIN_DIR"
  log "writing wrapper $WRAPPER_PATH"
  cat >"$WRAPPER_PATH" <<'WRAPPER'
#!/usr/bin/env bash
set -euo pipefail
export GINI_INSTANCE="${GINI_INSTANCE:-home}"
cd "$HOME/.gini/runtime"
exec bun run gini "$@"
WRAPPER
  chmod +x "$WRAPPER_PATH"
}

update_path() {
  local rc_file
  rc_file="$(detect_shell_rc)"
  local path_line='export PATH="$HOME/.local/bin:$PATH"'

  if [ -f "$rc_file" ] && grep -Fq "$path_line" "$rc_file"; then
    log "PATH entry already present in $rc_file"
    return
  fi

  log "appending PATH update to $rc_file"
  {
    printf '\n# Added by gini-agent installer\n'
    printf '%s\n' "$path_line"
  } >>"$rc_file"
}

initialize_instance() {
  log "initializing '$DEFAULT_INSTANCE' instance"
  (cd "$RUNTIME_DIR" && GINI_INSTANCE="$DEFAULT_INSTANCE" bun run gini install)
}

print_done() {
  local rc_file
  rc_file="$(detect_shell_rc)"
  cat <<DONE

gini-agent installed.

  runtime source: $RUNTIME_DIR
  wrapper:        $WRAPPER_PATH
  default state:  $HOME/.gini/instances/$DEFAULT_INSTANCE/

Next steps:
  1. Reload your shell to pick up PATH:
       source $rc_file
  2. Start the runtime and web UI:
       gini start
     gini start will print the runtime gateway URL and the web URL.
  3. Verify with:
       gini smoke

DONE
}

main() {
  OS="$(detect_os)"
  ARCH="$(detect_arch)"
  log "detected $OS/$ARCH"

  ensure_bun
  fetch_runtime
  install_deps
  write_wrapper
  update_path
  initialize_instance
  print_done
}

main "$@"
