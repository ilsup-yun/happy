#!/usr/bin/env bash
# Personal (ultracode) deploy helper: build + npm link + daemon restart + verify.
#
# Usage:
#   scripts/deploy-local.sh           deploy from the ultracode branch
#   scripts/deploy-local.sh --force   allow deploying from another branch
#
# Wraps `pnpm --filter happy cli:install` and adds:
#   - heals the claude-code claude.exe stub (pnpm 10 blocks its postinstall;
#     the stub has no shebang, so install verification dies with ENOEXEC -8)
#   - verifies the personal patch markers in the deployed build
#     (update MARKER CHECKS below when adding/removing personal patches)
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="$REPO/packages/happy-cli"
CLAUDE_PKG="$REPO/node_modules/@anthropic-ai/claude-code"

# --- branch guard: personal patches live on ultracode ---
branch="$(git -C "$REPO" rev-parse --abbrev-ref HEAD)"
if [[ "$branch" != "ultracode" && "${1:-}" != "--force" ]]; then
    echo "✗ current branch is '$branch' (expected 'ultracode'). Use --force to deploy anyway." >&2
    exit 1
fi

# --- heal claude.exe stub left by pnpm's blocked postinstall ---
stub="$CLAUDE_PKG/bin/claude.exe"
if [[ -f "$stub" ]] && ! file "$stub" | grep -q "Mach-O"; then
    echo "▶ claude.exe stub detected — running claude-code postinstall"
    node "$CLAUDE_PKG/install.cjs"
fi

# --- build + npm link + daemon restart + version check ---
# env -u: a shell inside an old happy/claude session may still carry
# DISABLE_AUTOUPDATER=1; don't let the restarted daemon inherit it.
cd "$REPO"
env -u DISABLE_AUTOUPDATER pnpm --filter happy cli:install

# --- MARKER CHECKS: personal patches expected in the deployed build ---
echo
echo "▶ verifying personal patch markers"
ok=1
grep -rq "ULTRACODE" "$CLI/dist" \
    || { echo "✗ ultracode injection marker missing in dist"; ok=0; }
grep -q "\[ultracode\]" "$CLI/scripts/claude_local_launcher.cjs" \
    || { echo "✗ launcher autoupdater patch missing"; ok=0; }
! grep -q "DISABLE_AUTOUPDATER = '1'" "$CLI/scripts/claude_local_launcher.cjs" \
    || { echo "✗ launcher still force-disables the autoupdater"; ok=0; }
[[ $ok -eq 1 ]] && echo "✓ all personal patch markers present"

echo
happy daemon status

[[ $ok -eq 1 ]] || exit 1
echo "✓ deployed $branch @ $(git -C "$REPO" rev-parse --short HEAD)"
