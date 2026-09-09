#!/bin/bash
set -e

# Bun installs to ~/.bun/bin; make sure it's reachable even if the user's
# shell hasn't exported it yet (covers "bun installed but not on PATH").
export PATH="$HOME/.bun/bin:$PATH"

# ─────────────────────────────────────────────
#  Plumbline — one-command setup (V1 / git-clone path)
#  Usage: curl -fsSL https://raw.githubusercontent.com/ByteBell/Plumbline/main/install.sh | bash
# ─────────────────────────────────────────────

REPO_URL="https://github.com/ByteBell/Plumbline"
# Clone the same branch this installer was published from, so the installed code
# matches the config schema it writes. Override with PLUMBLINE_BRANCH=... if needed.
REPO_BRANCH="${PLUMBLINE_BRANCH:-main}"

# ── helpers ──────────────────────────────────

print_step() { echo ""; echo "▶  $1"; }
print_ok()   { echo "  ✓  $1"; }
print_err()  { echo ""; echo "  ✗  ERROR: $1" >&2; }
print_info() { echo "  •  $1"; }

# ── what this will do ────────────────────────

echo ""
echo "This installer will:"
echo "  • clone Plumbline into ./plumbline (the current directory)"
echo "  • add a global 'plumbline' command"
echo "  • install project dependencies"

# ── 1. prerequisite checks ───────────────────

print_step "Checking prerequisites"

if ! command -v bun &>/dev/null; then
  print_err "Bun is not installed."
  echo ""
  echo "  Install it with:"
  echo "    curl -fsSL https://bun.sh/install | bash"
  echo "  then re-run this script."
  exit 1
fi
print_ok "Bun $(bun --version)"

# Docker is OPTIONAL. The recommended default is the embedded stack
# (SQLite + Ladybug + Honker) which needs no Docker at all. Docker is only
# required if you later choose "Docker" infra mode in `plumbline setup`
# (Neo4j). So this is an informational probe, never fatal.
check_docker_running() {
  # `docker info` can hang if the daemon is wedged or mid-start, so cap it.
  # Prefer GNU `timeout`/`gtimeout`; fall back to a plain call where neither exists.
  if command -v timeout &>/dev/null; then
    timeout 10 docker info >/dev/null 2>&1
  elif command -v gtimeout &>/dev/null; then
    gtimeout 10 docker info >/dev/null 2>&1
  else
    docker info >/dev/null 2>&1
  fi
}

if ! command -v docker &>/dev/null; then
  print_info "Docker not installed — fine for embedded mode (the default). Only needed if you pick Docker infra mode in 'plumbline setup'."
elif ! check_docker_running; then
  print_info "Docker installed but not running — fine for embedded mode (the default). Start Docker Desktop only if you choose Docker infra mode."
else
  print_ok "Docker $(docker --version | awk '{print $3}' | tr -d ',')"
fi

if ! command -v git &>/dev/null; then
  print_err "git is not installed. Install it and retry."
  exit 1
fi
print_ok "git $(git --version | awk '{print $3}')"

# ── 2. clone ─────────────────────────────────

print_step "Cloning Plumbline"

if [ -d "plumbline/.git" ]; then
  print_info "existing install detected at plumbline/ — leaving it untouched (no git pull)"
else
  git clone --branch "$REPO_BRANCH" "$REPO_URL" plumbline
fi
cd plumbline
REPO_DIR="$(pwd)"
print_ok "Repository ready"

# ── 3. install dependencies ───────────────────

print_step "Installing dependencies"
bun install --frozen-lockfile
print_ok "Dependencies installed"

# ── 4. wire the plumbline binary ──────────────
#  Symlinking the .ts entry directly is fragile — it relies on the shebang,
#  the executable bit, and bun's PATH resolution all lining up. A tiny wrapper
#  that execs `bun run` against the absolute entry path is reliable from any cwd.

print_step "Wiring plumbline binary"
BUN_PATH="$(command -v bun)"
BIN_DIR="$(dirname "$BUN_PATH")"
ENTRY="$REPO_DIR/packages/cli/src/index.ts"
cat > "$BIN_DIR/plumbline" <<EOF
#!/bin/bash
exec "$BUN_PATH" run "$ENTRY" "\$@"
EOF
chmod +x "$BIN_DIR/plumbline"
print_ok "plumbline → $ENTRY"

if command -v plumbline >/dev/null 2>&1; then
  print_ok "plumbline command available"
else
  print_info "plumbline isn't on your PATH yet — add this line to your shell profile:"
  echo "    export PATH=\"$BIN_DIR:\$PATH\""
fi

# ── 5. done ───────────────────────────────────

echo ""
echo "════════════════════════════════════════"
echo "  Plumbline installed!"
echo ""
echo "  Run the setup wizard to configure your LLM provider and boot:"
echo ""
echo "    plumbline setup"
echo ""
echo "  Commands reference:"
echo "    https://github.com/ByteBell/Plumbline/blob/main/commands.md"
echo "════════════════════════════════════════"
echo ""
