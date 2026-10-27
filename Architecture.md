# rust-tutor architecture

## Shape

```
browser (LAN: kai-lenovo, kai-surfy, AYCV6WY)
  │ https://kai-lenovo.fritz.box:5020  (local CA, ~/.local/share/lan-tls)
  ▼
docker "rust-tutor" (--network host, uid 1000:990, read-only rootfs, cap-drop ALL,
  │                  pids 256, mem 2g, cpus 2, tmpfs /tmp 512m, restart always)
  ├─ node 22 server (zero runtime deps: node:https, node:sqlite)
  │    ├─ rustc / rustfmt (pinned in the image, no cargo, no crates)
  │    └─ /data/progress.db  ◄── bind mount ~/.local/share/rust-tutor
  └─► pi-task-runner 127.0.0.1:4930  (CE lane, optional)
```

The process is a single Node server, with no build step for the frontend. Monaco 0.57 is copied out of npm at image build and served
offline from `web/vendor/monaco`.

## Server modules (`server/`)

| module | role |
| --- | --- |
| `main.mjs` | Reads env, wires the modules, and listens on one dual-stack `[::]` socket (TLS when the cert exists). Shuts down on SIGTERM. |
| `app.mjs` | The HTTP surface: security headers and CSP, JSON body limit (128 KiB), routes, static files with path containment. |
| `allowlist.mjs` | Source-IP allowlist. Admits loopback, kai-lenovo's own interface addresses, and the A/AAAA records of the hostnames in `allowlist.json`, re-resolved every 30 s because of IPv6 privacy addresses. |
| `lessons.mjs` | Loads and strictly validates `lessons/*.json` at startup. Any error refuses startup. `publicLevel`/`publicChallenge` strip references, harnesses and expected outputs. |
| `sandbox.mjs` | `runLimited`: prlimit rlimits, its own process group (a timeout kills the group), wall-clock timeout, output cap, scrubbed env. `createLimiter`: concurrency 2, queue 8, otherwise 429. |
| `rustc.mjs` | format / check / run / test / `--explain`. Every request gets a fresh temp crate dir, which is deleted afterwards. Diagnostics come from `--error-format=json`. |
| `verify.mjs` | Deterministic verdicts: `choice`, `output` (normalized stdout per case), `tests` (hidden harness appended, `rustc --test`), and `forbid`/`require` regexes over comment-stripped code. |
| `store.mjs` | SQLite (WAL) progress: XP, streak, spaced-repetition scheduling, agent cache. |
| `agent.mjs` | The CE-lane tutor (see below). |

API (all under `/api`; `GET /healthz` returns `{status, levels, challenges}`):
- `GET levels`, `GET progress`, `GET challenges/:id`;
- `PUT challenges/:id/code`, `POST challenges/:id/reset`;
- `POST format | check | run | verify`, `GET explain/:code`;
- `GET review`, `POST review/:id`;
- `GET agent/status`, `POST agent/hint|explain|review|judge`, `GET agent/jobs/:id`.

## Request order

1. **Tailscale is dropped before TLS.** A connection whose local address is on tailscale0 is destroyed in `connection`, so the tailnet never even sees a handshake.
2. **Allowlist.** A non-allowlisted source IP gets 403. This includes `/healthz`, and it is why the docker bridge (172.17.0.1) gets 403.
3. **Routing.** `/healthz`, then `/api/*`, then static files from `web/`.

Host networking is deliberate, as with duotronic-web. Docker's userland proxy has no IPv6 here and would rewrite IPv6 clients to 172.17.0.1, which defeats a source-IP allowlist. It also lets the server reach pi-task-runner on loopback.

## Sandbox envelope

Learner code is untrusted. The defense is layered:

| layer | limit |
| --- | --- |
| compile | 10 s wall, 15 s CPU, 3 GiB AS, 64 MiB fsize, 256 fds |
| run | 5 s wall, 5 s CPU, 256 MiB AS, 1 MiB fsize, 64 fds, 64 KiB captured output (then killed) |
| per request | 64 KiB source; at most 2 concurrent rustc jobs, queue of 8, then 429 |
| container | pids-limit 256 (fork bombs), memory 2g, cpus 2, read-only rootfs, /tmp is the only writable+exec place, cap-drop ALL, no-new-privileges, non-root |

Lessons are std-only and never need `std::process`, files or sockets, but the server does not reject such code. A compiled program shares the host network namespace and can read world-readable files in the image.
The mitigations are the non-root uid, the read-only rootfs, the rlimits and the time limits. This is acceptable for a single-learner LAN tool, but **not** for untrusted multi-tenant use.

## Learning flow

Each level has a quest story, concepts, a memory visualizer (`web/js/visual.js`, snapshot stepper with own/borrow/mut/moved arrows), 5–8 challenges
(predict → fix → complete → write → boss) and review cards. A level unlocks once the previous level's boss passes (`store.progress`). Within a level, a challenge opens once the previous one passes; this ordering is enforced by the UI only, and the API verifies any challenge.
XP is awarded on the first pass only (enforced by a unique index on `xp_events`). A streak is the count of consecutive active days in `TUTOR_TZ`.
Cards unlock when their `unlockAfter` challenge passes. The review queue uses SM-2-style ease and interval scheduling with grades 0–3.

## Deterministic verification vs. agent

**The agent never decides a pass.** `verify.mjs` decides every pass with rustc. The tutor tiers are gated on that result:

| tier | allowed when | output schema |
| --- | --- | --- |
| hint | always (counts a hint; the reference is shown to the agent only for hint ≥ 3) | `{hint, reveals_solution}` |
| explain | code fails verification (else 409) | `{explanation, next_step}` |
| review | code passes (else 409) | `{summary, strengths[], suggestions[{title,detail}], idiomatic_score 1–5}` |
| judge | code passes and the challenge has `judge: "agent"` (else 409) | `{pass, score 0–100, feedback}`. Advisory, cached by sha256(challengeId, code). |

### CE-lane job lifecycle

1. The browser calls `POST /api/agent/<tier>`. The server validates the request and runs `verifyChallenge`; a judge cache hit returns immediately.
   If 3 jobs are already active, it returns 429.
2. The prompt is built as `prompts/frame.md` + `prompts/<tier>.md`, rendered in a single pass.
   Learner code and check output sit between `<<<UNTRUSTED-<nonce>` … `UNTRUSTED-<nonce>>>>` markers (a fresh random nonce per job). The frame says that this text is data, that no tools may be used and that the reply is one JSON object.
3. The server submits `POST /v1/jobs {executor:"agent", role:"chief-engineer", prompt, timeoutSeconds, maxAttempts:1, idempotencyKey}` to pi-task-runner.
4. The browser polls `GET /api/agent/jobs/:id` every 2 s, and the server polls `GET /v1/jobs/<id>` on the runner.
   On `succeeded`, it extracts the JSON, validates it strictly against the tier schema and returns `done`.
   Anything else (`failed`, invalid JSON, schema mismatch) becomes `failed`, and after 120 s the result is `timeout` and the runner job is cancelled.
5. **Fallback.** Every non-`done` final state (`unavailable`, `failed`, `timeout`) carries a static fallback:
   - hint: the static hint with the same number;
   - explain: the failing check messages, a pointer to Diagnostics and `rustc --explain`, and the current static hint;
   - review: a generic idiom checklist;
   - judge: "passes every functional test, ask again later".
   `RUNNER_URL=` disables the agent entirely, and the UI then shows only static hints.

A sweeper refreshes unfinished jobs every 10 s, so the 120 s timeout and cancel apply even when the browser stops polling. Finished jobs are forgotten after 15 min. Local job state lives in memory only; a server restart loses in-flight tutor requests, but not judge cache entries.

## Data model (`/data/progress.db`)

| table | contents |
| --- | --- |
| `challenge_state` | per challenge: attempts, passes, first_passed_at, last_code, last_answer, hints_used |
| `attempts` | append-only verify log (challenge, passed, code hash) |
| `xp_events` | XP ledger; one `first-pass` per ref (unique partial index) |
| `activity` | active days, for the streak |
| `cards` | SM-2 state per unlocked card |
| `agent_cache` | judge results by key |

## Security posture

- LAN only: allowlist plus a Tailscale drop, TLS with the local CA, and no auth (a single learner).
- Hidden data never leaves the server: references, test harnesses, expected outputs, the predict answers before an attempt and the rubric. This is checked with `GET /api/levels` and `/api/challenges/*`.
- CSP: `default-src 'self'`, no inline scripts, `style-src 'self' 'unsafe-inline'` and `worker-src blob:` (both needed by Monaco), `frame-ancestors 'none'`. All Markdown is escaped (the `web/js/md.js` subset has no HTML and no links).
- Prompt injection: nonce-delimited data, a strict output schema, and the agent can't change progress. The judge is advisory.

## Testing

- `make test`: node:test suite in the image with the real rustc (allowlist, app routes, lessons validation, sandbox limits, rustc front end, verify, store, agent with a fake runner over HTTP, web md/visual).
- `make check-lessons`: every challenge's reference passes and starter fails, and the predict answers agree with rustc.
- `make smoke`: live API checks, including infinite loop, endless compile, memory hog, fork bomb and output flood.
- `make soak`: headless-Chromium UI walk-through of level 1 with Monaco markers, CSP-violation / off-origin / console-error checks, and a CE-lane hint.
- `make agent-e2e`: real pi-task-runner end to end; `EXPECT=unavailable` checks the fallback.
- `make verify-access`: the reachability matrix.

The evidence is in `~/.pi/chief-engineer/specs/rust-tutor/verification.md`.

## Known limitations

- Compiled learner programs share the host network namespace (see the sandbox section).
- Tutor latency is that of a full agent run, about 6–10 s per tier.
- The judge verdict is advisory and does not gate progress.
- The browser smoke drives level 1 only. Levels 2–5 are proven via check-lessons and the API.
