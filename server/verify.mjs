// Deterministic challenge verification. The agent judge never decides these.

// Drop line and block comments so forbid/require patterns only see code.
export function stripComments(code) {
  let out = "";
  let i = 0;
  while (i < code.length) {
    const two = code.slice(i, i + 2);
    if (two === "//") {
      while (i < code.length && code[i] !== "\n") i += 1;
    } else if (two === "/*") {
      let depth = 1;
      i += 2;
      while (i < code.length && depth > 0) {
        if (code.slice(i, i + 2) === "/*") (depth += 1), (i += 2);
        else if (code.slice(i, i + 2) === "*/") (depth -= 1), (i += 2);
        else i += 1;
      }
    } else if (code[i] === '"') {
      // Keep string literals intact (a "//" inside a string is not a comment).
      const start = i;
      i += 1;
      while (i < code.length && code[i] !== '"') i += code[i] === "\\" ? 2 : 1;
      i += 1;
      out += code.slice(start, i);
    } else if (code[i] === "'" && /^'(\\.[^']*|[^\\'])'/.test(code.slice(i, i + 12))) {
      // Char literal such as '"' or '\n' (an apostrophe alone is a lifetime).
      const lit = code.slice(i, i + 12).match(/^'(\\.[^']*|[^\\'])'/)[0];
      out += lit;
      i += lit.length;
    } else {
      out += code[i];
      i += 1;
    }
  }
  return out;
}

export function normalizeOutput(s) {
  return String(s)
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => l.trimEnd())
    .join("\n")
    .trimEnd();
}

function staticCases(check, code) {
  const bare = stripComments(code);
  const cases = [];
  for (const f of check.forbid || []) {
    if (new RegExp(f.pattern).test(bare)) cases.push({ name: "rule", passed: false, message: f.message });
  }
  for (const f of check.require || []) {
    if (!new RegExp(f.pattern).test(bare)) cases.push({ name: "rule", passed: false, message: f.message });
  }
  return cases;
}

function runtimeNote(run) {
  if (!run) return undefined;
  if (run.timedOut) return "killed: exceeded the 5 s run time limit";
  if (run.truncated) return "killed: output exceeded 64 KiB";
  if (run.signal) return `killed by ${run.signal}`;
  return undefined;
}

/**
 * @param {ReturnType<import('./rustc.mjs').createRust>} rust
 * @param {object} ch      full (server-side) challenge
 * @param {{code?: string, answer?: string}} submission
 */
export async function verifyChallenge(rust, ch, submission) {
  const check = ch.check;
  if (check.kind === "choice") {
    const passed = submission.answer === check.answer;
    return {
      kind: "choice",
      passed,
      cases: [
        {
          name: "prediction",
          passed,
          message: passed
            ? "Correct prediction."
            : submission.answer
              ? "Not quite. Press Check to see what rustc actually says, then reason about why."
              : "Pick an answer first.",
        },
      ],
    };
  }

  const code = submission.code ?? "";
  const rules = staticCases(check, code);

  if (check.kind === "tests") {
    const r = await rust.test(code, check.harness);
    if (!r.compile.ok) {
      const harnessOnly = r.compile.diagnostics.length > 0 && r.compile.diagnostics.filter((d) => d.level.startsWith("error")).every((d) => d.inHarness);
      return {
        kind: "tests",
        passed: false,
        compile: r.compile,
        cases: [
          ...rules,
          {
            name: "compile",
            passed: false,
            message: r.compile.timedOut
              ? "compilation exceeded the 10 s limit"
              : harnessOnly
                ? "Your code compiles on its own, but the hidden tests can't use it: check the required function names and signatures."
                : "Your code does not compile yet. See the diagnostics.",
          },
        ],
      };
    }
    const note = runtimeNote(r.run);
    const cases = r.cases.length
      ? r.cases.map((c) => ({ name: c.name, passed: c.passed, message: c.message }))
      : [{ name: "tests", passed: false, message: note || "the test binary produced no results" }];
    if (note && r.cases.length) cases.push({ name: "runtime", passed: false, message: note });
    return {
      kind: "tests",
      passed: rules.length === 0 && cases.every((c) => c.passed),
      compile: r.compile,
      cases: [...rules, ...cases],
    };
  }

  // output
  const r = await rust.run(code, check.cases.map((c) => c.stdin ?? ""));
  if (!r.compile.ok) {
    return {
      kind: "output",
      passed: false,
      compile: r.compile,
      cases: [...rules, { name: "compile", passed: false, message: r.compile.timedOut ? "compilation exceeded the 10 s limit" : "Your code does not compile yet. See the diagnostics." }],
    };
  }
  const cases = check.cases.map((c, i) => {
    const run = r.runs[i];
    const note = runtimeNote(run);
    const ok = !note && run.exitCode === 0 && normalizeOutput(run.stdout) === normalizeOutput(c.expected);
    let message;
    if (!ok) {
      message = note
        ? note
        : run.exitCode !== 0
          ? `exited with code ${run.exitCode}${run.stderr ? `: ${run.stderr.trim().split("\n")[0]}` : ""}`
          : `expected:\n${normalizeOutput(c.expected)}\n\ngot:\n${normalizeOutput(run.stdout) || "(no output)"}`;
    }
    return { name: c.name, passed: ok, message };
  });
  return {
    kind: "output",
    passed: rules.length === 0 && cases.every((c) => c.passed),
    compile: r.compile,
    cases: [...rules, ...cases],
  };
}
