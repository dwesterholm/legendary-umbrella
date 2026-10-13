#!/bin/zsh
# Veckokörningen för bevakningen (Phase 14.2, WATCH-06, D-16, R-06).
# Startas av launchd (com.bostadai.weekly-watch.plist) måndag 07:00, eller för hand.
#
# Hemligheter (ANTHROPIC_API_KEY, WATCH_SMTP_URL, WATCH_EMAIL_TO ...) ligger i ~/.zshenv och
# läses härifrån. Den här filen skriver aldrig ut miljön eller några variabelvärden och
# använder aldrig skalspårning. Flaggan som släpper in betalda Apify-sidor skickas aldrig med (R-03): veckojobbet
# kan inte kosta Apify-pengar.
#
# WATCH_DRY_RUN=1 lägger till --dry-run (bara förkontroller, ingen hämtning).

# ~/.zshenv först, innan striktläget slås på (en användares egen fil får referera till
# variabler som inte är satta).
if [ -f "$HOME/.zshenv" ]; then
  . "$HOME/.zshenv"
fi

set -eu

# Repots rot utifrån skriptets egen plats.
SCRIPT_DIR="${0:A:h}"
REPO_ROOT="${SCRIPT_DIR:h:h}"
cd "$REPO_ROOT"

# node: behåll en som redan finns på PATH, annars den senast installerade under ~/.nvm.
if ! command -v node >/dev/null 2>&1; then
  NVM_NODE_BINS=("$HOME"/.nvm/versions/node/*/bin(N/om))
  if [ "${#NVM_NODE_BINS[@]}" -gt 0 ]; then
    export PATH="${NVM_NODE_BINS[1]}:$PATH"
  fi
fi

ARGS=(--renderer local --window all --email)
if [ "${WATCH_DRY_RUN:-}" = "1" ]; then
  ARGS+=(--dry-run)
fi
ARGS+=("$@")

echo "Start: $(date -u +%Y-%m-%dT%H:%M:%SZ)"

# launchd stops a job by sending SIGTERM to THIS shell, not to the programs it started. A shell that is
# only waiting for a foreground child dies on SIGTERM and leaves the child to be killed hard, so the
# browser is never closed gracefully and the lock file stays behind (WR-09). Therefore the run is started
# in the background and TERM/INT are forwarded to it; fit-score.ts then closes Chromium and exits 143/130.
# Keeping the Mac awake is a separate caffeinate tied to this shell's pid (-w): it ends when the shell ends,
# however that happens, so it never needs to relay signals.
caffeinate -i -w $$ &
CAFFEINATE_PID=$!

./node_modules/.bin/tsx scripts/fit-score.ts "${ARGS[@]}" &
CHILD=$!
trap 'kill -TERM "$CHILD" 2>/dev/null || true' TERM INT

CODE=0
wait "$CHILD" || CODE=$?
# A forwarded signal ends the first wait at once (status 128+n) while the run is still closing the browser;
# wait again to collect its own exit code.
if kill -0 "$CHILD" 2>/dev/null; then
  wait "$CHILD" || CODE=$?
fi
trap - TERM INT
kill "$CAFFEINATE_PID" 2>/dev/null || true

echo "Slut: $(date -u +%Y-%m-%dT%H:%M:%SZ), kod $CODE"
exit "$CODE"
