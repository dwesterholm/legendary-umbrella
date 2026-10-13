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

CODE=0
caffeinate -i ./node_modules/.bin/tsx scripts/fit-score.ts "${ARGS[@]}" || CODE=$?

echo "Slut: $(date -u +%Y-%m-%dT%H:%M:%SZ), kod $CODE"
exit "$CODE"
