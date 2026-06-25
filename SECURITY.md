# Security Policy

## Scope

PeachMint is a fully client-side browser application. All processing occurs
locally on the user's device. There is no backend, no user accounts, and no
data transmission.

The most relevant security concerns are:

- **Client-side XSS** via untrusted filenames or metadata rendered into the DOM
- **Malicious media files** that exploit WebCodecs or browser decode paths
- **Supply chain** — CDN-loaded dependencies
- **Privacy** — ensuring no user data egress (telemetry, external API calls, etc.)

## Reporting a Vulnerability

If you discover a security vulnerability, please **do not open a public GitHub issue**.

Instead, report it privately:

1. Email: [maintainer contact — add before public release]
2. Or use GitHub's private vulnerability reporting feature (if enabled on this repo)

Please include:
- A description of the vulnerability and its potential impact
- Steps to reproduce or a proof-of-concept (safe demo preferred)
- Your suggested fix if you have one

We aim to respond within 72 hours and to issue a patch within 14 days for confirmed issues.

## Security design notes

- All `<dialog>` elements are in-DOM — no `window.open`, no `alert()`/`confirm()`/`prompt()`
- Filenames and user-supplied strings are HTML-escaped before DOM insertion
- CDN dependencies are loaded at pinned exact versions; SRI hashes will be added before v1.0
- `Content-Security-Policy` is configured to restrict inline scripts and external fetches
- `navigator.storage.persist()` is requested to protect against silent eviction

## Out of scope

- Vulnerabilities in the user's browser itself (WebCodecs, WebGL, etc.)
- Attacks requiring physical access to the user's device
- Vulnerabilities in third-party CDN infrastructure
