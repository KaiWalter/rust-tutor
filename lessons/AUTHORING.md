# Authoring lessons

One JSON file per level: `lessons/level-N.json`. The server validates every
file at startup (`server/lessons.mjs`) and refuses to start on any error.
`make check-lessons` additionally proves, with the real rustc in the image,
that every challenge is solvable and not pre-solved.

## Level shape

Progress is stored by level and challenge **id**, never by `order`. You can insert levels and renumber
`order` freely, but never rename an id that has shipped. A level with any saved progress stays unlocked even
if a level inserted before it hasn't been beaten yet.

```jsonc
{
  "id": "ownership",                  // kebab-case, unique across all levels
  "order": 4,                         // sequence and unlock order: 1..n without gaps
  "label": "1",                       // optional, shown to the learner ("0A", "1"); 1–4 letters/digits, unique; default String(order)
  "section": "core",                  // optional: "prelude" | "core" (default); prelude levels must come first
  "title": "Ownership & Moves",       // ≤ 80 chars
  "summary": "…",                     // ≤ 300 chars, shown on the level map
  "quest": { "title": "…", "story": "…" },      // story ≤ 3000 chars, Markdown
  "concepts": [{ "title": "…", "body": "…" }],  // 1–8 short narrations, Markdown, body ≤ 2500
  "visual": { … },                    // stack/heap stepper, see below
  "challenges": [ … ],                // 5–8; all five kinds present; last one is the boss
  "cards": [ … ]                      // 3–20 spaced-repetition cards
}
```

Markdown subset (`web/js/md.js`): paragraphs, `#`/`##`/`###` headings,
`-` and `1.` lists, fenced code blocks, `` `inline` ``, `**bold**`, `*italic*`.
No HTML, no links, no images. Everything is escaped.

## Visual (memory stepper)

```jsonc
"visual": {
  "title": "Moving a String",
  "code": "let a = String::from(\"hi\");\nlet b = a;",   // shown above the diagram
  "steps": [                                           // 2–40 full snapshots
    {
      "line": 1,                                       // 1-based line of `code` to highlight
      "note": "a owns a heap buffer",                  // one sentence
      "stack": [{ "frame": "main", "vars": [{ "id": "a", "name": "a", "value": "ptr,len 2,cap 2", "state": "live" }] }],
      "heap": [{ "id": "h1", "label": "\"hi\"", "state": "live" }],
      "arrows": [{ "from": "a", "to": "h1", "kind": "own" }]
    }
  ]
}
```

- var `state`: `live` (default), `moved` (moved-from, struck through), `dropped` (faded), `frozen` (borrowed, can't be mutated right now).
- heap `state`: `live` | `freed`.
- arrow `kind`: `own` (solid green), `borrow` (`&`, dashed blue), `mut` (`&mut`, dashed amber), `moved` (dotted grey).
- Arrows may point var → heap or var → var (a reference to another local).
- Ids are unique within a step. Keep the same id for the same thing across steps so it doesn't re-animate.
- Labels are short: stack labels are cut at 20 chars and heap labels at 19.

## Challenges

```jsonc
{
  "id": "l1-move-predict",          // kebab-case, unique across ALL levels (prefix with the label: l1-, l0a-)
  "title": "…",                     // ≤ 80
  "kind": "predict" | "fix" | "complete" | "write" | "boss",
  "xp": 10,                         // predict 10, fix/complete 15, write 20, boss 40 (guideline)
  "story": "…",                     // optional quest framing, ≤ 1500
  "prompt": "…",                    // Markdown task, ≤ 4000; say exactly what is checked
  "starter": "…",                   // code shown in the editor (the code to predict, for predict)
  "reference": "…",                 // full passing solution (predict: the correct choice id)
  "hints": ["…", "…", "…"],         // 1–5 static hints, escalating (used when the tutor is offline)
  "check": { … },
  "judge": "agent", "rubric": "…"   // optional, see below
}
```

### Check kinds

- **choice** (only for `predict`):
  `{ "kind": "choice", "answer": "E0382", "compilerAgrees": true }` plus `"choices": [{ "id": "compiles", "label": "…" }, …]` (2–6) on the challenge.
  Every predict challenge must be machine-checked.
  - Use `compilerAgrees: true` with the answer `compiles`, `panics` or a rustc error code such as `E0382`. check-lessons compiles or runs the starter and confirms the answer.
  - Or set `"output": "exact stdout"`. check-lessons runs the starter and compares its stdout, normalized for trailing whitespace.
  Distractors should be plausible misconceptions.
- **output**: `{ "kind": "output", "cases": [{ "name": "…", "stdin": "optional", "expected": "exact stdout" }] }` (1–10 cases).
  - The program must exit with status 0.
  - Comparison trims trailing whitespace per line and at the end.
  - Expected output is never shown to the learner up front. The prompt must specify the format exactly.
- **tests**: `{ "kind": "tests", "harness": "#[cfg(test)]\nmod hidden_tests {\n    use super::*;\n    #[test]\n    fn …() { … }\n}" }`.
  The harness is appended after the learner's code and compiled with `rustc --test -A dead_code -A unused`.
  - The prompt must name the exact function, type and method signatures the tests use.
  - Test names are shown to the learner, so make them descriptive (`empty_input_returns_none`). The harness code is never shown.
  - Learner code still needs a `fn main()`, which may be empty.
- Optional on any compiled check: `"forbid"` / `"require"`: `[{ "pattern": "regex", "message": "shown on failure" }]`.
  These are matched against the code with comments stripped, string literals kept.
  Use them for "without `.clone()`" or "must use `?`" constraints.

### Kind conventions

- `predict`: short program (≤ 15 lines). The question is "what happens?", answered by choices. The editor is read-only.
- `fix`: starter fails to compile (or fails the check) for exactly the reason the level teaches. The prompt says what must stay the same.
- `complete`: starter has the scaffolding with `todo!()` in the parts to fill. A `tests` check is typical.
- `write`: a near-blank starter with a precise spec. Mark it with `"judge": "agent"` and a rubric about idiom: the tutor judges idiom after the compiler passes.
- `boss`: the last challenge. Combines the level's ideas, is bigger, worth 40+ XP, and unlocks the next level.

### Hard rules (check-lessons enforces most)

- Reference passes, starter fails.
- Edition 2021, std only, no `unsafe`, no `std::process`, no files, no network, no threads unless the level is about them.
- References compile without warnings (check-lessons prints them) and are `rustfmt`-clean (run Format on them).
- Starters should be rustfmt-clean too. The fix-it starters are expected to fail compiling.
- Runs finish well under 5 s (256 MiB address space).
- Never put the solution in a hint before the last one. Hints escalate from a nudge, to a pointer, to near-solution.

### Judge rubric

The rubric is sent to the tutor together with the learner's already-passing code. It returns `{pass, score 0–100, feedback}`.
Describe what idiomatic looks like for this exercise and which shortcuts are not acceptable, e.g. "uses `&str` parameters, not `&String`; no `.clone()` to dodge the borrow checker".

## Cards

```jsonc
{ "id": "l1-card-move", "front": "What happens to `a` after `let b = a;` when `a: String`?", "back": "…", "unlockAfter": "l1-move-fix" }
```

`unlockAfter` defaults to the level's first challenge. A card joins the review queue once that challenge is passed.
Front ≤ 600 chars, back ≤ 1200 chars, Markdown.

## Checking

```sh
make check-lessons                                   # whole lessons/ dir, real rustc in the image
# one file, without rebuilding the image:
docker run --rm --init --read-only --tmpfs /tmp:rw,exec,nosuid,nodev,size=512m --cap-drop ALL \
  -v "$PWD/lessons:/lessons:ro" rust-tutor:latest \
  node --disable-warning=ExperimentalWarning scripts/check-lessons.mjs /lessons/level-3.json
# try a snippet:
printf 'fn main() { println!("hi"); }' | docker run --rm -i --read-only --tmpfs /tmp:rw,exec rust-tutor:latest \
  sh -c 'cat > /tmp/m.rs && rustc --edition 2021 -o /tmp/m /tmp/m.rs && /tmp/m'
```
