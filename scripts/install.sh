#!/usr/bin/env bash
set -euo pipefail

REPO_URL="https://github.com/Lilac-Labs/gini-agent"
RUNTIME_DIR="$HOME/.gini/runtime"
BIN_DIR="$HOME/.local/bin"
WRAPPER_PATH="$BIN_DIR/gini"
DEFAULT_INSTANCE="home"
PATH_MANUAL=0

log() {
  printf '[gini-install] %s\n' "$*"
}

err() {
  printf '[gini-install] error: %s\n' "$*" >&2
}

detect_os() {
  if [ "$(uname -o 2>/dev/null || true)" = "Android" ]; then
    err "Android / Termux is not supported by gini-agent"
    err "Bun has limited support on Termux and the runtime is not tested there"
    exit 1
  fi
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
    zsh)
      if [ -n "${ZDOTDIR:-}" ] && [ -d "$ZDOTDIR" ] && [ -w "$ZDOTDIR" ]; then
        printf '%s/.zshrc' "$ZDOTDIR"
      else
        printf '%s/.zshrc' "$HOME"
      fi
      ;;
    bash)
      if [ "$OS" = "darwin" ]; then
        printf '%s/.bash_profile' "$HOME"
      else
        printf '%s/.bashrc' "$HOME"
      fi
      ;;
    fish) printf '%s/.config/fish/config.fish' "$HOME" ;;
    *)
      if [ "$OS" = "darwin" ]; then
        printf '%s/.zshrc' "$HOME"
      else
        printf '%s/.bashrc' "$HOME"
      fi
      ;;
  esac
}

detect_shell_name() {
  local shell_name=""
  if [ -n "${SHELL:-}" ]; then
    shell_name="$(basename "$SHELL")"
  fi
  printf '%s' "$shell_name"
}

ensure_bun() {
  if command -v bun >/dev/null 2>&1; then
    log "bun already installed: $(bun --version)"
    return
  fi

  log "bun not found; installing via https://bun.sh/install"
  curl -fsSL https://bun.sh/install | bash
  export PATH="${BUN_INSTALL:-$HOME/.bun}/bin:$PATH"

  if ! command -v bun >/dev/null 2>&1; then
    local bun_install_dir="${BUN_INSTALL:-$HOME/.bun}"
    if [ -x "$bun_install_dir/bin/bun" ]; then
      export PATH="$bun_install_dir/bin:$PATH"
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
    local existing_origin existing_normalized expected_normalized
    existing_origin="$(git -C "$RUNTIME_DIR" remote get-url origin 2>/dev/null || true)"
    existing_normalized="${existing_origin%.git}"
    expected_normalized="${REPO_URL%.git}"
    if [ -z "$existing_origin" ] || [ "$existing_normalized" != "$expected_normalized" ]; then
      err "directory $RUNTIME_DIR has a different origin ($existing_origin); refusing to overwrite."
      err "Move or remove it and re-run the installer."
      exit 1
    fi
    log "updating existing runtime at $RUNTIME_DIR"
    git -C "$RUNTIME_DIR" fetch origin
    git -C "$RUNTIME_DIR" reset --hard origin/main
  elif [ -d "$RUNTIME_DIR" ] && [ -n "$(ls -A "$RUNTIME_DIR" 2>/dev/null || true)" ]; then
    err "$RUNTIME_DIR exists but is not a git checkout."
    err "Remove it (or move it aside) and re-run the installer."
    exit 1
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
  if [ -e "$WRAPPER_PATH" ] && ! grep -Fq 'gini-agent-installer-managed' "$WRAPPER_PATH" 2>/dev/null; then
    err "$WRAPPER_PATH already exists and is not managed by this installer."
    err "Remove or move it (e.g. mv \"$WRAPPER_PATH\" \"$WRAPPER_PATH.bak\") and re-run the installer."
    exit 1
  fi
  log "writing wrapper $WRAPPER_PATH"
  cat >"$WRAPPER_PATH" <<'WRAPPER'
#!/usr/bin/env bash
# gini-agent-installer-managed
set -euo pipefail
export GINI_INSTANCE="${GINI_INSTANCE:-home}"
cd "$HOME/.gini/runtime"
exec bun run gini "$@"
WRAPPER
  chmod +x "$WRAPPER_PATH"
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
    log "PATH entry already present in $rc_file"
    return 0
  fi

  if [ -e "$rc_file" ] && [ ! -w "$rc_file" ]; then
    err "$rc_file is not writable; add this line manually to enable the gini command:"
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

  log "appending PATH update to $rc_file"
  {
    printf '\n# Added by gini-agent installer\n'
    printf '%s\n' "$path_line"
  } >>"$rc_file" 2>/dev/null || {
    err "could not write to $rc_file; add this line manually:"
    err "  $path_line"
    PATH_MANUAL=1
    return 0
  }
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
  if [ "$PATH_MANUAL" = "1" ]; then
    cat <<'MANUAL'
Note: the installer could not update your shell rc automatically.
Add $HOME/.local/bin to your PATH manually (see message above) so the
`gini` command is found.

MANUAL
  fi
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
