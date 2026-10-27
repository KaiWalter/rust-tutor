# rust-tutor

> **AI-generated software disclaimer.** This project was designed and written almost entirely by AI: the code was produced by Claude Code (Claude Opus 5.5) under the direction of a human, and the lesson content, explanations and tests were AI-authored too. The lessons were checked by compiling the reference and starter solutions with real `rustc`, but they have **not** had a systematic human review, so they may contain mistakes, simplifications or non-idiomatic Rust. Verify anything important against [The Rust Book](https://doc.rust-lang.org/book/). The software is provided as is, without warranty (see [LICENSE](LICENSE)).

A self-hosted Rust *language* course (no cargo, crates or tooling) with eight levels and 56 challenges. It runs as a small web app you can use from any machine on your LAN.

## Highlights

- Prelude (0A First Steps, 0B Strings & Text, 0C Collections & Loops), then five core levels: Ownership, Borrowing & Lifetimes, Structs/Enums/Match, Traits & Generics, Option/Result error handling.
- Monaco editor (bundled, works offline) with Rust highlighting, `rustfmt` formatting and `rustc` diagnostics as inline markers, plus error-code explanations.
- Animated stack/heap and ownership/borrow visualizer, XP, streaks and a spaced-repetition review queue.
- Challenge types: predict the output or error, fix the compile error, complete the function, write from scratch, boss challenges. Hidden tests decide pass or fail; every challenge's reference solution passes and its starter fails (`make check-lessons`).
- Optional AI tutor (hints, failure explanations, code review, judging of open-ended exercises). Written for the author's pi-task-runner setup; without it the tutor falls back to static hints (`RUNNER_URL=` empty).

## Quick start

Requires Docker, `make` and Node 22 (only for the smoke scripts).

`make run` expects `server.crt` and `server.key` in `CERT_DIR` (default `~/.local/share/lan-tls`). A throwaway self-signed pair is enough:

```sh
mkdir -p ~/.local/share/lan-tls && openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
  -subj "/CN=$(hostname)" -keyout ~/.local/share/lan-tls/server.key -out ~/.local/share/lan-tls/server.crt
make run RUNNER=          # build and start without the AI tutor
make health
```

Then open `https://<host>:5020/`. Edit `allowlist.json` to admit other machines on your LAN by hostname (it ships with the author's hosts). The `make health`, `verify-access` and `HOSTNAME_LAN` defaults are author-specific; override them as needed.

## Security notes

Your code is compiled and run with plain `rustc` as a subprocess inside the container (non-root, read-only root filesystem, CPU/memory/time/output limits), but it shares the container's network. This is meant for **one trusted learner on a private LAN**; do not expose it to the internet or untrusted users.

## License

MIT, see [LICENSE](LICENSE). Monaco Editor is bundled via npm under its own MIT license.

---

**URL:** https://kai-lenovo.fritz.box:5020/ (LAN only, via the local CA in `~/.local/share/lan-tls`)

The toolchain (rustc and rustfmt) lives in the Docker image. The host needs Docker, plus Node 22 for the smoke scripts.
See [Architecture.md](Architecture.md) for how it works.

## Make targets

| target | what it does |
| --- | --- |
| `make build` | build `rust-tutor:latest` (node 22 + rustc + rustfmt) |
| `make run` | build, then (re)create the container: host network, `:5020` dual-stack TLS, non-root, read-only rootfs, data in `~/.local/share/rust-tutor` |
| `make stop` / `make restart` | remove the container / stop and run again (progress survives: it lives in the volume) |
| `make logs` | follow the container logs |
| `make health` | `GET /healthz` over TLS with the LAN CA |
| `make test` | full unit and integration suite inside the image (real rustc), same sandbox flags as prod |
| `make test-host` | the host-only subset; the rustc-backed tests skip themselves |
| `make check-lessons` | for every challenge, the reference passes, the starter fails and the predict answers agree with rustc |
| `make verify-access` | LAN v4/v6 return 200, a docker-bridge client gets 403, tailscale0 does not answer |
| `make smoke` | API smoke against the running container: format, check, run, verify and every limit |
| `make soak` | headless-Chromium smoke of the UI (needs `PLAYWRIGHT_CORE`/`CHROMIUM`, see the script header) |
| `make agent-e2e` | tutor end-to-end through the real pi-task-runner; `EXPECT=unavailable` checks the fallback |

Overridable make variables: `IMAGE NAME PORT DATA CERT_DIR RUNNER HOSTNAME_LAN RUN_EXTRA`.
`RUN_EXTRA` passes extra `docker run` arguments. `make run RUNNER=` starts with the tutor switched off.

## Server environment

| var | default | |
| --- | --- | --- |
| `PORT` | `5020` | |
| `BIND_HOST` | `::` | dual-stack (ipv6Only=false) |
| `TLS_CERT` / `TLS_KEY` | `/certs/server.{crt,key}` in the image | plain HTTP if `TLS_CERT` is empty or the file is missing |
| `DATA_DIR` | `/data` in the image | holds `progress.db` (SQLite, WAL) |
| `LESSONS_DIR` | `lessons/` | |
| `PROMPTS_DIR` | `prompts/` | tutor prompt templates |
| `STATIC_DIR` | `web/` | |
| `ALLOWLIST_CONFIG` | `allowlist.json` | LAN hostnames, re-resolved every 30 s |
| `RUNNER_URL` | `http://127.0.0.1:4930` | pi-task-runner; **empty string disables the tutor** (static hints only) |
| `AGENT_ROLE` | `chief-engineer` | pi-task-runner role for tutor jobs |
| `AGENT_TIMEOUT_S` | `120` | per tutor request; the runner job is cancelled after this |
| `COMPILE_CONCURRENCY` | `2` | parallel rustc jobs; a full queue returns 429 |
| `TUTOR_TZ` | `Europe/Berlin` | day boundary for streaks |

## Keyboard

Press `?` in the app for the full list.

- `Ctrl+Enter` runs, `Ctrl+Shift+Enter` verifies and `Ctrl+B` checks (diagnostics only).
- `Alt+Shift+F` formats and `Alt+Shift+Backspace` resets to the starter.
- `Alt+H` asks for a hint, `Alt+E` explains the errors, `Alt+R` reviews and `Ctrl+Shift+E` explains the error code at the cursor.
- `Alt+N` / `Alt+P` go to the next/previous challenge, `Alt+1..4` switch to the output/tests/diagnostics/tutor tab, and `1..9` pick a predict choice.
- `Alt+M` opens the map and `Alt+V` opens the review queue (`Space` reveals a card, `1..4` grades it).
- `Esc` closes overlays.

## Lessons

Lessons are JSON files in `lessons/`. See [lessons/AUTHORING.md](lessons/AUTHORING.md). Run `make check-lessons` after any change.

Track 1 is `level-0a/0b/0c.json` (section `prelude`, labels 0A–0C, order 1–3) and then `level-1..5.json` (section `core`, labels 1–5, order 4–8).
Progress is keyed by level and challenge id, so inserting or renumbering levels keeps learner data. A level with any saved progress is never locked.
