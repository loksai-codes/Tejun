import { build, type BuildResult, type Diagnostic } from "@tejun/compiler";
import { useEffect, useMemo, useRef, useState } from "react";
import { Editor, type EditorHandle } from "./Editor";
import { EXAMPLES } from "./examples";
import { t, type Lang } from "./logic/i18n";
import { toMarkers } from "./logic/markers";

const FILE = "program.tejun";
const CHECK_DELAY_MS = 200;

export function App() {
  const [lang, setLang] = useState<Lang>("en");
  const [exampleId, setExampleId] = useState(EXAMPLES[0]!.id);
  const [source, setSource] = useState(EXAMPLES[0]!.program);
  const [result, setResult] = useState<BuildResult>(() => build(FILE, EXAMPLES[0]!.program));
  const editor = useRef<EditorHandle | null>(null);

  // Re-check shortly after typing stops.
  useEffect(() => {
    const timer = setTimeout(() => setResult(build(FILE, source)), CHECK_DELAY_MS);
    return () => clearTimeout(timer);
  }, [source]);

  const markers = useMemo(() => toMarkers(result.diagnostics, result.source, lang), [result, lang]);
  const example = EXAMPLES.find((e) => e.id === exampleId);
  const edited = example !== undefined && example.program !== source;

  const loadExample = (id: string) => {
    const next = EXAMPLES.find((e) => e.id === id)!;
    setExampleId(id);
    setSource(next.program);
  };

  return (
    <div className="app" lang={lang}>
      <header className="topbar">
        <div className="brand">
          <h1>{t("title", lang)}</h1>
          <p>{t("tagline", lang)}</p>
        </div>
        <div className="topbar-controls">
          <label className="field">
            <span>{t("example", lang)}</span>
            <select value={exampleId} onChange={(e) => loadExample(e.target.value)}>
              {EXAMPLES.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name[lang]}
                  {e.id === exampleId && edited ? ` ${t("custom", lang)}` : ""}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="button" onClick={() => setLang(lang === "en" ? "ja" : "en")}>
            {t("language", lang)}
          </button>
        </div>
      </header>

      <main className="workspace">
        <section className="pane editor-pane" aria-label="Tejun source">
          <Editor value={source} onChange={setSource} markers={markers} label="Tejun source" handle={editor} />
          <Diagnostics diagnostics={result.diagnostics} lang={lang} onSelect={(d) => editor.current?.reveal(d.span.line, d.span.col)} />
        </section>
      </main>
    </div>
  );
}

function Diagnostics({ diagnostics, lang, onSelect }: { diagnostics: readonly Diagnostic[]; lang: Lang; onSelect(d: Diagnostic): void }) {
  return (
    <div className="diagnostics" role="status" aria-live="polite">
      <h2>
        {t("errors", lang)} <span className="count">{diagnostics.length}</span>
      </h2>
      {diagnostics.length === 0 ? (
        <p className="ok">{t("noErrors", lang)}</p>
      ) : (
        <ul>
          {diagnostics.map((d, i) => (
            <li key={i}>
              <button type="button" onClick={() => onSelect(d)}>
                <span className="code">{d.code}</span>
                <span className="where">
                  {d.span.line}:{d.span.col}
                </span>
                <span className="message">{lang === "ja" ? d.messageJa : d.message}</span>
                {d.help ? <span className="help">help: {d.help}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
