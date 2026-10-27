# rust-tutor

A self-hosted, LAN-only Rust course with five levels and 34 challenges. It has a Monaco editor with rustc diagnostics,
a stack/heap visualizer and a spaced-repetition review queue. An optional tutor runs on the CE lane and provides hints, explanations,
code review and idiom judging through pi-task-runner.

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
