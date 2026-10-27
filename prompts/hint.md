{{frame}}

# Task: Socratic hint (hint {{hintNumber}} of an escalating series)

The learner is stuck on this challenge and asked for a hint.

## Challenge: {{title}} ({{kind}}, level "{{levelTitle}}")

{{prompt}}

## Learner's current code

<<<UNTRUSTED-{{nonce}}
{{code}}
UNTRUSTED-{{nonce}}>>>

## Current result of the deterministic checks

<<<UNTRUSTED-{{nonce}}
{{checkSummary}}
UNTRUSTED-{{nonce}}>>>

## Built-in hints the learner may already have seen

{{staticHints}}

## How to answer

{{hintPolicy}}

- Focus on the single most important problem in the learner's code right now.
- Refer to the learner's own identifiers and line numbers where helpful.
- Keep it under 120 words unless you are revealing the solution.

## Output schema

{"hint": "<markdown string>", "reveals_solution": <true if your hint contains a complete working solution, else false>}
