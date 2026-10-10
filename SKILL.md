---
name: github-push
description: Safely commit and push the Token-View repo to GitHub. Use whenever the user asks to push, sync, or publish changes. Covers privacy scan, local verification, rebase, conflict resolution, and push.
---

# GitHub Push Skill (Token-View)

Follow these steps in order. Stop and ask the user if any step fails in a way
not covered below.

## 1. Review what is about to be committed

```bash
cd ~/Token-View
git status --short
git diff --stat
```

Rules:

- `plugins/*.js` (except `plugins/.gitkeep`) and `config/sources.json` must
  **never** appear — they are git-ignored local-only files. If they show up as
  `??` or `A`, stop: the `.gitignore` is broken, fix it first.
- Every other new/modified file must be intentional. Ask if unsure.

## 2. Privacy scan

No personal data may enter the public tree:

```bash
git diff HEAD -- . ':(exclude)plugins' | grep -niE "/home/|/run/media|linuxbrew|maindisk|normal.file" && echo "LEAK FOUND — STOP" || echo "clean"
grep -rniE "antigravity|/\.gemini/|opencode\.db" --include="*.js" --include="*.html" --include="*.json" --include="*.md" --include="*.sh" --include="*.service" --include="*.desktop" server.js public/ examples/ config/sources.example.json install/ README.md || echo "clean"
```

Exception: the public GitHub URL (`github.com/Demon720AA/Token-View`) and the
word `opencode` inside `examples/` are intentional. Anything matching a real
`$HOME`, username, or machine path is a leak — remove it before continuing.

## 3. Verify it still runs

```bash
for f in $(git diff --name-only HEAD -- '*.js'); do node --check "$f" || exit 1; done
systemctl --user restart token-view.service 2>/dev/null || node server.js &
sleep 8
for p in / /api/summary /api/sources; do curl -s -o /dev/null -w "%{http_code} $p\n" "localhost:4173$p"; done
```

All routes must return `200`. If the service is not installed on this machine,
run `node server.js` in the background instead and kill it afterwards.

## 4. Commit

```bash
git add -A
git -c user.name="Demon720AA" -c user.email="Demon720AA@users.noreply.github.com" \
  commit -m "<type>: <what changed>"
```

Types: `Add`, `Fix`, `Theme`, `Split`, `Docs`, `Refactor`. Keep the subject
under 72 chars, add a short body for multi-file changes.

## 5. Sync with remote

```bash
timeout 60 git push -u origin main
```

- **Auth failed** → stop and tell the user to provide a token (`repo` scope).
  Push again with `git push -u origin main`.
- **Rejected (fetch first)** → `git pull --rebase origin main`.
  - Conflict in `README.md` or docs the user owns → keep ours:
    `git checkout --ours <file> && git add <file>`.
  - Conflict in code → stop and ask the user.
  - Finish with `GIT_EDITOR=true git rebase --continue`, then push again.
- **Editor error on rebase --continue** (`/usr/bin/msedit` missing) → retry
  with `GIT_EDITOR=true` prefixed, as above.

## 6. Confirm

```bash
git log --oneline -3
timeout 60 git push origin main   # expect "Everything up-to-date" or fast-forward
```

Report the commit hash and what was pushed.
