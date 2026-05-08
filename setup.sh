#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════╗
# ║        JOHN MODICA AI SHELL — Electron Edition v2.0                    ║
# ║        One-shot setup script — NOT part of the repo                    ║
# ║        Run this ONCE from the folder containing your .txt files         ║
# ╚══════════════════════════════════════════════════════════════════════════╝
set -e

PURPLE='\033[0;35m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

banner() {
  echo -e "${PURPLE}"
  echo "  ╔════════════════════════════════════════╗"
  echo "  ║       JOHN MODICA AI SHELL v2.0        ║"
  echo "  ║         Setup & Install Script         ║"
  echo "  ╚════════════════════════════════════════╝"
  echo -e "${NC}"
}

step()  { echo -e "\n${CYAN}▶ $1${NC}"; }
ok()    { echo -e "${GREEN}  ✓ $1${NC}"; }
warn()  { echo -e "${YELLOW}  ⚠ $1${NC}"; }
fail()  { echo -e "${RED}  ✗ $1${NC}"; exit 1; }

# ─── 0. Banner ────────────────────────────────────────────────────────────────
banner

# ─── 1. Prerequisite checks ───────────────────────────────────────────────────
step "Checking prerequisites..."

# Node.js 18+
if ! command -v node &>/dev/null; then
  fail "Node.js not found. Install from https://nodejs.org (v18 LTS or higher)"
fi
NODE_VER=$(node -e "process.exit(parseInt(process.version.slice(1)) < 18 ? 1 : 0)" 2>/dev/null && echo "ok" || echo "old")
if [[ "$NODE_VER" == "old" ]]; then
  fail "Node.js 18+ required. Current: $(node --version). Install from https://nodejs.org"
fi
ok "Node.js $(node --version)"

# npm
if ! command -v npm &>/dev/null; then
  fail "npm not found. It ships with Node.js — reinstall Node."
fi
ok "npm $(npm --version)"

# Python3 (needed for native module builds)
if command -v python3 &>/dev/null; then
  ok "Python $(python3 --version)"
else
  warn "python3 not found — native builds may fail. Install: sudo apt install python3"
fi

# Build essentials (Linux)
if [[ "$OSTYPE" == "linux-gnu"* ]]; then
  if command -v gcc &>/dev/null; then
    ok "gcc $(gcc --version | head -1)"
  else
    warn "gcc not found. Run: sudo apt install build-essential"
  fi
fi

# curl
if ! command -v curl &>/dev/null; then
  fail "curl not found. Install: sudo apt install curl"
fi
ok "curl available"

# Ollama
if command -v ollama &>/dev/null; then
  ok "Ollama $(ollama --version 2>/dev/null || echo 'installed')"
else
  warn "Ollama not found. Install from https://ollama.ai — required for local AI."
  warn "After install, run: ollama pull tinyllama && ollama serve"
fi

# ─── 2. Directory structure ───────────────────────────────────────────────────
step "Creating directory structure..."

mkdir -p renderer/components
mkdir -p assets/xterm
mkdir -p assets/marked
mkdir -p assets/sounds
mkdir -p plugins/weather
mkdir -p plugins/calc
mkdir -p db
mkdir -p logs
ok "Directory tree created"

# ─── 3. Rename .txt source files ──────────────────────────────────────────────
step "Renaming source files..."

rename_file() {
  local src="$1"
  local dst="$2"
  if [[ -f "$src" ]]; then
    cp "$src" "$dst"
    ok "  $src → $dst"
  else
    warn "  $src not found — skipping"
  fi
}

# Root-level files
rename_file "package.json.txt"          "package.json"
rename_file "main.js.txt"               "main.js"
rename_file "preload.js.txt"            "preload.js"
rename_file "electron-builder.yml.txt"  "electron-builder.yml"

# Renderer files
rename_file "index.html.txt"            "renderer/index.html"
rename_file "app.js.txt"               "renderer/app.js"
rename_file "persona.js.txt"           "renderer/persona.js"
rename_file "ai-router.js.txt"         "renderer/ai-router.js"
rename_file "terminal.js.txt"          "renderer/terminal.js"
rename_file "storage.js.txt"           "renderer/storage.js"
rename_file "voice.js.txt"             "renderer/voice.js"
rename_file "voice-engine.js.txt"      "renderer/voice-engine.js"
rename_file "webviews.js.txt"          "renderer/webviews.js"
rename_file "settings.js.txt"          "renderer/settings.js"
rename_file "plugins.js.txt"           "renderer/plugins.js"

# CSS
rename_file "style.css.txt"            "renderer/components/style.css"

# Update main.js to point to renderer/ subfolder if needed
ok "All source files placed"

# ─── 4. Download asset bundles ────────────────────────────────────────────────
step "Downloading asset bundles (xterm.js, marked.js)..."

DL_OK=true

dl() {
  local url="$1"
  local dest="$2"
  if [[ -f "$dest" ]]; then
    ok "  Already exists: $dest"
    return
  fi
  echo -e "  Downloading $dest..."
  if curl -fsSL "$url" -o "$dest"; then
    ok "  $dest"
  else
    warn "  Failed: $dest — you may need to download it manually"
    DL_OK=false
  fi
}

dl "https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.js"              "assets/xterm/xterm.js"
dl "https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.css"             "assets/xterm/xterm.css"
dl "https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.js" "assets/xterm/addon-fit.js"
dl "https://cdn.jsdelivr.net/npm/marked@12.0.0/marked.min.js"           "assets/marked/marked.min.js"

if [[ "$DL_OK" == "false" ]]; then
  warn "Some assets failed to download. Check your internet connection and re-run."
fi

# ─── 5. Create .env template ──────────────────────────────────────────────────
step "Creating .env template..."

if [[ ! -f ".env" ]]; then
cat > .env << 'ENVEOF'
# John Modica AI Shell — Environment Variables
# Copy this file and fill in real values. Never commit .env to git.

# Ollama local endpoint (default)
OLLAMA_URL=http://localhost:11434
OLLAMA_MODEL=tinyllama

# Cloud AI provider (optional fallback)
CLOUD_API_URL=https://api.openai.com/v1
CLOUD_API_KEY=
CLOUD_MODEL=gpt-4o

# ElevenLabs voice cloning (optional — for advanced voice-engine.js)
ELEVENLABS_API_KEY=
ELEVENLABS_VOICE_ID=

# Hotword detection (future)
HOTWORD_ENABLED=false
HOTWORD_PHRASE=hey modica
ENVEOF
  ok ".env template created"
else
  ok ".env already exists — not overwritten"
fi

# ─── 6. Create .gitignore ─────────────────────────────────────────────────────
step "Creating .gitignore..."

if [[ ! -f ".gitignore" ]]; then
cat > .gitignore << 'GIEOF'
node_modules/
dist/
.env
*.db
*.db-shm
*.db-wal
logs/
db/
*.log
.DS_Store
Thumbs.db
assets/xterm/
assets/marked/
*.txt.bak
GIEOF
  ok ".gitignore created"
else
  ok ".gitignore already exists — not overwritten"
fi

# ─── 7. Create example plugin stubs ──────────────────────────────────────────
step "Creating example plugin stubs..."

cat > plugins/weather/manifest.json << 'PLUGEOF'
{
  "name": "weather",
  "version": "1.0.0",
  "description": "Slash command /weather <city> — returns mock weather data",
  "main": "index.js",
  "permissions": ["network"]
}
PLUGEOF

cat > plugins/weather/index.js << 'PLUGEOF'
// Weather plugin stub — replace with real API (OpenWeatherMap, wttr.in, etc.)
module.exports = {
  name: 'weather',
  onLoad(api) {
    api.registerSlashCommand('weather', async (args) => {
      const city = args.join(' ') || 'Unknown';
      return `☁ Weather for **${city}**: 72°F, partly cloudy. (Live data: add API key to .env)`;
    });
  },
  onUnload() {}
};
PLUGEOF

cat > plugins/calc/manifest.json << 'PLUGEOF'
{
  "name": "calc",
  "version": "1.0.0",
  "description": "Slash command /calc <expression> — evaluates safe math",
  "main": "index.js",
  "permissions": []
}
PLUGEOF

cat > plugins/calc/index.js << 'PLUGEOF'
// Calc plugin — safe math evaluator using Function constructor guard
module.exports = {
  name: 'calc',
  onLoad(api) {
    api.registerSlashCommand('calc', async (args) => {
      const expr = args.join(' ');
      try {
        const allowed = /^[0-9+\-*/().\s%^]+$/;
        if (!allowed.test(expr)) return '⚠ Invalid expression. Only numbers and operators allowed.';
        // eslint-disable-next-line no-new-func
        const result = new Function(`"use strict"; return (${expr})`)();
        return `🧮 \`${expr}\` = **${result}**`;
      } catch (e) {
        return `⚠ Calc error: ${e.message}`;
      }
    });
  },
  onUnload() {}
};
PLUGEOF

ok "Plugin stubs created (plugins/weather, plugins/calc)"

# ─── 8. npm install ───────────────────────────────────────────────────────────
step "Running npm install..."
npm install
ok "npm install complete"

# ─── 9. Rebuild native modules ────────────────────────────────────────────────
step "Rebuilding native modules for Electron (node-pty, better-sqlite3)..."
echo "  This may take 1-3 minutes on first run..."
if npx electron-rebuild -f -w node-pty,better-sqlite3 2>&1; then
  ok "Native modules rebuilt"
else
  warn "electron-rebuild had issues. Try: sudo apt install build-essential python3-dev"
  warn "Then re-run: npx electron-rebuild -f -w node-pty,better-sqlite3"
fi

# ─── 10. Pull Ollama model ────────────────────────────────────────────────────
step "Pulling tinyllama model via Ollama (CPU-optimised, ~637MB)..."
if command -v ollama &>/dev/null; then
  if ollama list 2>/dev/null | grep -q "tinyllama"; then
    ok "tinyllama already pulled"
  else
    echo "  Pulling tinyllama (this will take a moment)..."
    ollama pull tinyllama && ok "tinyllama ready" || warn "Pull failed — run manually: ollama pull tinyllama"
  fi
else
  warn "Ollama not installed — skipping model pull"
  warn "Install Ollama then run: ollama pull tinyllama && ollama serve"
fi

# ─── 11. Final summary ────────────────────────────────────────────────────────
echo ""
echo -e "${PURPLE}╔══════════════════════════════════════════════════════════╗${NC}"
echo -e "${PURPLE}║              SETUP COMPLETE — JOHN MODICA AI            ║${NC}"
echo -e "${PURPLE}╚══════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "${GREEN}  Directory layout ready          ✓${NC}"
echo -e "${GREEN}  Source files renamed            ✓${NC}"
echo -e "${GREEN}  Assets downloaded               ✓${NC}"
echo -e "${GREEN}  .env template created           ✓${NC}"
echo -e "${GREEN}  npm dependencies installed      ✓${NC}"
echo -e "${GREEN}  Native modules rebuilt          ✓${NC}"
echo ""
echo -e "${CYAN}  Next steps:${NC}"
echo -e "  1. Edit ${YELLOW}.env${NC} — add any API keys you want (optional)"
echo -e "  2. Make sure Ollama is running: ${YELLOW}ollama serve${NC}"
echo -e "  3. Launch the app:  ${YELLOW}npm start${NC}"
echo -e "  4. Dev mode (DevTools open):  ${YELLOW}npm run dev${NC}"
echo ""
echo -e "${CYAN}  Keyboard shortcuts:${NC}"
echo -e "  ${YELLOW}Ctrl+N${NC}       New chat"
echo -e "  ${YELLOW}Ctrl+,${NC}       Settings"
echo -e "  ${YELLOW}Ctrl+M${NC}       Mode selector"
echo -e "  ${YELLOW}Ctrl+Space${NC}   Push-to-talk (voice)"
echo -e "  ${YELLOW}Ctrl+Shift+K${NC} Clear conversation"
echo -e "  ${YELLOW}Ctrl+?${NC}       Keyboard shortcuts help"
echo -e "  ${YELLOW}Ctrl+Shift+T${NC} New terminal tab"
echo ""
echo -e "${PURPLE}  John Modica AI Shell v2.0 — built by Copilot for John${NC}"
echo ""
