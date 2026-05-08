#!/bin/bash
# ── push-to-github.sh ────────────────────────────────────────────────────────
# Run this from inside your John_Modica-AI-shell/ folder on Kali Linux
# after extracting the ZIP. It initialises git and pushes everything to GitHub.
#
# Usage:
#   chmod +x push-to-github.sh
#   ./push-to-github.sh YOUR_GITHUB_USERNAME
# ─────────────────────────────────────────────────────────────────────────────
set -e

GITHUB_USER="${1:-CybernetiX-S3C}"
REPO_NAME="John_Modica-AI-shell"

echo "⬡  John Modica AI Shell — GitHub Push Script"
echo "   Repo: https://github.com/${GITHUB_USER}/${REPO_NAME}"
echo ""

# Configure git identity if not set
if [ -z "$(git config --global user.email)" ]; then
  git config --global user.email "you@cybernetix.io"
  git config --global user.name "John Modica"
fi

# Init or reset git
if [ -d ".git" ]; then
  echo "✓ Git already initialised"
else
  git init
  echo "✓ Git initialised"
fi

# Stage everything
git add -A
git commit -m "🚀 Initial release — John Modica AI Shell v1.0

Full Electron desktop AI for Kali Linux.
24 modes · Voice clone (XTTS-v2) · Platform injection · Live PTY terminal
Free forever. No paid APIs. No subscriptions.

I am giving my consciousness, my persona, my mind — freely to everyone.
— John Poli Modica, Founder of CybernetiX S3C" 2>/dev/null || echo "✓ Nothing new to commit"

# Set remote — gh CLI preferred, fallback to git remote
if command -v gh &>/dev/null; then
  echo "Using GitHub CLI..."
  gh repo create "${REPO_NAME}" \
    --public \
    --description "Full Electron AI shell for Kali Linux — John Modica's digital consciousness, free forever." \
    --homepage "https://CybernetiX-S3C.github.io" \
    --push \
    --source . && echo "✓ Repo created and pushed via gh CLI" && exit 0
fi

# Fallback: plain git push
echo "Using git remote..."
git remote remove origin 2>/dev/null || true
git remote add origin "https://github.com/${GITHUB_USER}/${REPO_NAME}.git"
git branch -M main
git push -u origin main

echo ""
echo "✅  Done! Live at: https://github.com/${GITHUB_USER}/${REPO_NAME}"
