// CodeMirror-backed file editor for the workspace panel.
//
// Lazy-loaded (see WorkspacePanel) so CodeMirror only loads when a file is
// opened, keeping the base chunk small for the common chat-only flow. Provides
// syntax highlighting, line numbers, in-editor search (Ctrl/⌘-F) and theme
// that follows the app's light/dark palette.


import { css } from "@codemirror/lang-css";
import { go } from "@codemirror/lang-go";
import { html } from "@codemirror/lang-html";
import { java } from "@codemirror/lang-java";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { sql } from "@codemirror/lang-sql";
import { yaml } from "@codemirror/lang-yaml";
import { search } from "@codemirror/search";
import { githubDark, githubLight } from "@uiw/codemirror-theme-github";
import CodeMirror, { EditorView, type Extension } from "@uiw/react-codemirror";
import { useMemo } from "react";

function languageFor(path: string): Extension | null {
  const base = path.split(/[/\\]/).pop() ?? path;
  const ext = base.includes(".") ? base.slice(base.lastIndexOf(".") + 1).toLowerCase() : "";
  switch (ext) {
    case "js":
    case "mjs":
    case "cjs":
      return javascript();
    case "jsx":
      return javascript({ jsx: true });
    case "ts":
    case "mts":
    case "cts":
      return javascript({ typescript: true });
    case "tsx":
      return javascript({ jsx: true, typescript: true });
    case "py":
    case "pyi":
      return python();
    case "go":
      return go();
    case "rs":
      return rust();
    case "java":
      return java();
    case "json":
    case "jsonc":
      return json();
    case "yaml":
    case "yml":
      return yaml();
    case "sql":
      return sql();
    case "html":
    case "htm":
    case "xml":
      return html();
    case "css":
      return css();
    case "md":
    case "markdown":
      return markdown();
    default:
      return null;
  }
}

export function CodeEditor({
  path,
  value,
  readOnly,
  dark,
  onChange,
}: {
  path: string;
  value: string;
  readOnly: boolean;
  dark: boolean;
  onChange(next: string): void;
}): React.ReactElement {
  const extensions = useMemo(() => {
    const exts: Extension[] = [search({ top: true }), EditorView.lineWrapping];
    const lang = languageFor(path);
    if (lang) exts.push(lang);
    return exts;
  }, [path]);

  return (
    <CodeMirror
      value={value}
      height="100%"
      theme={dark ? githubDark : githubLight}
      editable={!readOnly}
      readOnly={readOnly}
      extensions={extensions}
      onChange={onChange}
      basicSetup={{
        lineNumbers: true,
        foldGutter: true,
        highlightActiveLine: !readOnly,
        highlightActiveLineGutter: !readOnly,
        autocompletion: false,
      }}
      style={{ height: "100%", fontSize: "12px" }}
    />
  );
}
