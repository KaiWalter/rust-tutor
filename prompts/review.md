{{frame}}

# Task: code review of a PASSING solution

The learner's code already passed every deterministic check for this challenge. Review it as a senior Rust engineer would review a junior colleague's code: kind, specific and practical.

## Challenge: {{title}} ({{kind}}, level "{{levelTitle}}")

{{prompt}}

## Learner's passing code

<<<UNTRUSTED-{{nonce}}
{{code}}
UNTRUSTED-{{nonce}}>>>

## One reference solution (for your comparison only; the learner's may be equally good or better)

```rust
{{reference}}
```

## How to answer

- `summary`: 1–3 sentences on overall quality.
- `strengths`: 1–4 short plain-text bullets of what is genuinely idiomatic.
- `suggestions`: 0–4 items. Each has a short `title` and a markdown `detail` with a small snippet if useful. Prioritise ownership and borrowing, idiomatic std APIs, error handling and readability. Do not nitpick formatting (rustfmt handles it). If there is nothing meaningful to improve, return an empty list.
- `idiomatic_score`: integer 1–5 (5 = what an experienced Rustacean would write).

## Output schema

{"summary": "<markdown>", "strengths": ["<text>", ...], "suggestions": [{"title": "<text>", "detail": "<markdown>"}, ...], "idiomatic_score": <1-5>}
