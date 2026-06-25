# Contributing to PeachMint

Thank you for your interest in contributing! PeachMint is open-source and
welcomes contributions of all kinds.

## Getting started

No build step is required. Clone the repo and serve it locally:

```bash
git clone https://github.com/sprizzlesites/peachmint.git
cd peachmint
python -m http.server 8080
# then open http://localhost:8080
```

Or use any static file server (Caddy, `npx serve`, VS Code Live Server, etc.).

## Code style

- **Vanilla JavaScript, native ES modules** — no framework, no bundler, no npm required to run
- **Small single-responsibility files** — keep engine code (no DOM) separate from UI code
- **No comments explaining what code does** — name things well instead
- **Do** add a comment when the WHY is non-obvious: quirks, constraints, workarounds
- Dark terminal-leaning aesthetic; mobile-first responsive CSS

## Module rules

- Files in `src/engine/` must have **zero DOM/UI dependencies**
- Files in `src/ui/` may import from `src/engine/` but not vice versa
- Workers (`src/workers/`) communicate via `postMessage` only — no shared globals

## Dependencies

- Prefer **cdnjs** for CDN-hosted libs; jsDelivr/unpkg only when cdnjs doesn't host
- Pin **exact versions** — no `^` or `~` ranges
- Add new deps to `DEPENDENCIES.md` and `NOTICE` before merging
- No proprietary or non-commercial-use-only libraries

## Pull requests

1. Fork the repo and create a branch: `git checkout -b feat/your-feature`
2. Make your changes; make sure the app runs without errors in a fresh browser tab
3. Open a PR with a clear description of what you changed and why
4. PRs that add features should target the relevant phase (see `PROGRESS.md`)

## Reporting bugs

Open a GitHub issue. Include:
- Browser + version
- Steps to reproduce
- What you expected vs. what happened
- Console errors if any

## Code of Conduct

See `CODE_OF_CONDUCT.md`. Be kind.
