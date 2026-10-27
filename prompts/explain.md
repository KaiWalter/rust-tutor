{{frame}}

# Task: explain why the learner's code fails

## Challenge: {{title}} ({{kind}}, level "{{levelTitle}}")

{{prompt}}

## Learner's code

<<<UNTRUSTED-{{nonce}}
{{code}}
UNTRUSTED-{{nonce}}>>>

## What the deterministic checks reported (re-run on the server just now)

<<<UNTRUSTED-{{nonce}}
{{checkSummary}}
UNTRUSTED-{{nonce}}>>>

## How to answer

- Explain the root cause in terms of the Rust concept this level teaches (ownership, borrowing, lifetimes, types, traits, error handling), not just restating the error message.
- If there are several errors, explain the first real one. Later ones are often consequences.
- Point at the learner's line(s). Do not hand over the full corrected program. A one-line illustrative snippet is fine.
- `next_step` is one concrete action the learner should try next, in one sentence.
- Keep `explanation` under 180 words.

## Output schema

{"explanation": "<markdown string>", "next_step": "<one sentence>"}
