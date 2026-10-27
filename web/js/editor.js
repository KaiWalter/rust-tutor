// Monaco wiring: offline AMD load, theme matched to theme.css, rustc
// diagnostics -> model markers (hover shows message, labels, notes), rustc
// suggestions -> quick fixes, E-codes -> "Explain" code action, rustfmt as the
// document formatter.

const VS = "/vendor/monaco/vs";

export function loadMonaco() {
  return new Promise((resolve, reject) => {
    if (!window.require?.config) return reject(new Error("Monaco loader missing"));
    window.require.config({ paths: { vs: VS } });
    window.require(["vs/editor/editor.main"], () => resolve(window.monaco), reject);
  });
}

// Colours come from theme.css (--ui-*) so the editor sits inside the app chrome.
const THEME = {
  base: "vs-dark",
  inherit: true,
  rules: [
    { token: "comment", foreground: "718096", fontStyle: "italic" },
    { token: "keyword", foreground: "6cb6ff" },
    { token: "keyword.type", foreground: "4fd1c5" },
    { token: "type", foreground: "4fd1c5" },
    { token: "type.identifier", foreground: "4fd1c5" },
    { token: "string", foreground: "a5e9c5" },
    { token: "string.escape", foreground: "7ff0c5" },
    { token: "number", foreground: "f4b740" },
    { token: "attribute", foreground: "b4a1ff" },
    { token: "annotation", foreground: "b4a1ff" },
    { token: "operator", foreground: "9eb0d4" },
    { token: "delimiter", foreground: "9eb0d4" },
    { token: "identifier", foreground: "f2f6ff" },
  ],
  colors: {
    "editor.background": "#03050c",
    "editor.foreground": "#f2f6ff",
    "editorLineNumber.foreground": "#3b4a78",
    "editorLineNumber.activeForeground": "#9eb0d4",
    "editor.lineHighlightBackground": "#0b1020",
    "editor.lineHighlightBorder": "#00000000",
    "editor.selectionBackground": "#0f2db399",
    "editor.inactiveSelectionBackground": "#0f2db355",
    "editorCursor.foreground": "#0072ef",
    "editorIndentGuide.background1": "#18213d",
    "editorIndentGuide.activeBackground1": "#23315c",
    "editorWidget.background": "#0b1020",
    "editorWidget.border": "#23315c",
    "editorHoverWidget.background": "#0b1020",
    "editorHoverWidget.border": "#23315c",
    "editorSuggestWidget.background": "#0b1020",
    "editorSuggestWidget.border": "#23315c",
    "editorSuggestWidget.selectedBackground": "#101a3a",
    "editorError.foreground": "#f05252",
    "editorWarning.foreground": "#f4b740",
    "editorInfo.foreground": "#008bd0",
    "editorGutter.background": "#03050c",
    "scrollbarSlider.background": "#23315c88",
    "scrollbarSlider.hoverBackground": "#23315ccc",
    "focusBorder": "#0072ef",
    "input.background": "#070b16",
    "input.border": "#23315c",
    "list.hoverBackground": "#0d1430",
    "list.activeSelectionBackground": "#101a3a",
    "peekViewEditor.background": "#070b16",
  },
};

const ECODE = /^E\d{4}$/;

/** Convert server diagnostics into Monaco markers, clamped to the model. */
export function diagnosticsToMarkers(monaco, model, diagnostics) {
  const markers = [];
  const lines = model.getLineCount();
  const clampLine = (l) => Math.max(1, Math.min(lines, l));
  for (const d of diagnostics || []) {
    const sev = d.level.startsWith("error") ? monaco.MarkerSeverity.Error : d.level === "warning" ? monaco.MarkerSeverity.Warning : monaco.MarkerSeverity.Info;
    const primary = d.spans.find((s) => s.primary) || d.spans[0];
    const notes = d.children.map((c) => `${c.level}: ${c.message}`);
    if (!primary) {
      // Harness-only or crate-level diagnostics: pin to line 1 so they are visible.
      markers.push({ severity: sev, message: [d.message, ...notes].join("\n"), code: d.code || undefined, source: "rustc", startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: model.getLineMaxColumn(1) });
      continue;
    }
    for (const s of d.spans) {
      const startLineNumber = clampLine(s.lineStart);
      const endLineNumber = clampLine(s.lineEnd);
      const isPrimary = s === primary;
      const msg = isPrimary ? [d.message + (s.label ? `\n${s.label}` : ""), ...notes].join("\n") : `${s.label || d.message}`;
      markers.push({
        severity: isPrimary ? sev : monaco.MarkerSeverity.Info,
        message: msg,
        code: d.code || undefined,
        source: "rustc",
        startLineNumber,
        startColumn: Math.max(1, s.colStart),
        endLineNumber,
        endColumn: Math.max(s.colStart + 1, Math.min(s.colEnd, model.getLineMaxColumn(endLineNumber))),
      });
    }
  }
  return markers;
}

/** Collect machine-applicable rustc suggestions as Monaco edits. */
export function suggestionsFrom(diagnostics) {
  const out = [];
  for (const d of diagnostics || []) {
    for (const c of d.children) {
      const edits = c.spans.filter((s) => typeof s.suggestion === "string");
      if (edits.length) out.push({ title: `rustc ${c.level}: ${c.message}`, code: d.code, edits });
    }
  }
  return out;
}

/**
 * @param {HTMLElement} host
 * @param {{ format(code): Promise<{ok, code?, error?}>, explain(code): void, onChange(): void }} hooks
 */
export async function createEditor(host, hooks) {
  const monaco = await loadMonaco();
  monaco.editor.defineTheme("rust-tutor", THEME);
  const model = monaco.editor.createModel("", "rust", monaco.Uri.parse("file:///main.rs"));
  const editor = monaco.editor.create(host, {
    model,
    theme: "rust-tutor",
    automaticLayout: true,
    fontSize: 14,
    fontFamily: '"JetBrains Mono", "Fira Code", ui-monospace, "Cascadia Code", Menlo, Consolas, monospace',
    fontLigatures: true,
    minimap: { enabled: false },
    tabSize: 4,
    insertSpaces: true,
    rulers: [100],
    scrollBeyondLastLine: false,
    renderWhitespace: "selection",
    lightbulb: { enabled: "on" },
    fixedOverflowWidgets: true,
    padding: { top: 8 },
  });

  let diagnostics = [];
  let readOnlyReason = null;

  monaco.languages.registerDocumentFormattingEditProvider("rust", {
    displayName: "rustfmt",
    async provideDocumentFormattingEdits(m) {
      const r = await hooks.format(m.getValue());
      if (!r?.ok) return [];
      return [{ range: m.getFullModelRange(), text: r.code }];
    },
  });

  monaco.languages.registerCodeActionProvider("rust", {
    provideCodeActions(m, range, context) {
      const actions = [];
      for (const s of suggestionsFrom(diagnostics)) {
        const touches = s.edits.some((e) => e.lineStart <= range.endLineNumber && e.lineEnd >= range.startLineNumber);
        if (!touches) continue;
        actions.push({
          title: s.title.length > 90 ? `${s.title.slice(0, 89)}…` : s.title,
          kind: "quickfix",
          edit: {
            edits: s.edits.map((e) => ({
              resource: m.uri,
              versionId: m.getVersionId(),
              textEdit: { range: new monaco.Range(e.lineStart, e.colStart, e.lineEnd, e.colEnd), text: e.suggestion },
            })),
          },
        });
      }
      const codes = new Set(context.markers.map((mk) => (typeof mk.code === "string" ? mk.code : mk.code?.value)).filter((c) => c && ECODE.test(c)));
      for (const code of codes) actions.push({ title: `Explain ${code}`, kind: "quickfix", command: { id: "rust-tutor.explain", title: `Explain ${code}`, arguments: [code] } });
      return { actions, dispose() {} };
    },
  });
  monaco.editor.registerCommand("rust-tutor.explain", (_accessor, code) => hooks.explain(code));

  model.onDidChangeContent(() => hooks.onChange?.());

  function setDiagnostics(list) {
    diagnostics = list || [];
    monaco.editor.setModelMarkers(model, "rustc", diagnosticsToMarkers(monaco, model, diagnostics));
  }

  /** The E-code of the diagnostic under the cursor, else the first one present. */
  function codeAtCursor() {
    const pos = editor.getPosition();
    const markers = monaco.editor.getModelMarkers({ resource: model.uri });
    const code = (mk) => (typeof mk.code === "string" ? mk.code : mk.code?.value);
    const here = markers.find((mk) => code(mk) && pos && mk.startLineNumber <= pos.lineNumber && mk.endLineNumber >= pos.lineNumber);
    return code(here || {}) || code(markers.find((mk) => code(mk)) || {}) || null;
  }

  return {
    monaco,
    editor,
    model,
    getValue: () => model.getValue(),
    setValue(v) {
      // pushEditOperations keeps undo history across Reset/Format.
      model.pushEditOperations([], [{ range: model.getFullModelRange(), text: v }], () => null);
      setDiagnostics([]);
    },
    load(v) {
      model.setValue(v);
      setDiagnostics([]);
    },
    setDiagnostics,
    codeAtCursor,
    reveal(line, col) {
      editor.revealLineInCenter(line);
      editor.setPosition({ lineNumber: line, column: col || 1 });
      editor.focus();
    },
    format: () => editor.getAction("editor.action.formatDocument").run(),
    setReadOnly(reason) {
      readOnlyReason = reason;
      editor.updateOptions({ readOnly: Boolean(reason), readOnlyMessage: reason ? { value: reason } : undefined });
    },
    get readOnly() {
      return readOnlyReason;
    },
    addKey(keybinding, run) {
      editor.addCommand(keybinding, run);
    },
  };
}
