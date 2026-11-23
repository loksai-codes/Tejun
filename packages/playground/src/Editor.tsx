// Monaco editor for Tejun, with live error markers.

import EditorWorker from "monaco-esm/editor/editor.worker.js?worker";
import * as monaco from "./monaco";
import { useEffect, useRef } from "react";
import type { Marker } from "./logic/markers";
import { TEJUN_LANGUAGE_ID, tejunLanguage, tejunLanguageConfiguration } from "./logic/tejun-language";

(globalThis as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
};

let registered = false;
function registerTejun(): void {
  if (registered) return;
  registered = true;
  monaco.languages.register({ id: TEJUN_LANGUAGE_ID, extensions: [".tejun"] });
  monaco.languages.setMonarchTokensProvider(TEJUN_LANGUAGE_ID, tejunLanguage as unknown as monaco.languages.IMonarchLanguage);
  monaco.languages.setLanguageConfiguration(
    TEJUN_LANGUAGE_ID,
    tejunLanguageConfiguration as unknown as monaco.languages.LanguageConfiguration,
  );
}

const darkQuery = typeof window !== "undefined" ? window.matchMedia("(prefers-color-scheme: dark)") : undefined;
const theme = () => (darkQuery?.matches ? "vs-dark" : "vs");

export interface EditorHandle {
  reveal(line: number, column: number): void;
}

interface Props {
  value: string;
  onChange(value: string): void;
  markers: readonly Marker[];
  label: string;
  handle?: React.RefObject<EditorHandle | null>;
}

export function Editor({ value, onChange, markers, label, handle }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    registerTejun();
    const model = monaco.editor.createModel(value, TEJUN_LANGUAGE_ID);
    model.setEOL(monaco.editor.EndOfLineSequence.LF);
    const instance = monaco.editor.create(container.current!, {
      model,
      theme: theme(),
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 13,
      lineNumbersMinChars: 3,
      scrollBeyondLastLine: false,
      tabSize: 2,
      ariaLabel: label,
      renderValidationDecorations: "on",
    });
    editor.current = instance;
    const sub = model.onDidChangeContent(() => onChangeRef.current(model.getValue()));
    const onTheme = () => monaco.editor.setTheme(theme());
    darkQuery?.addEventListener("change", onTheme);
    if (handle) {
      handle.current = {
        reveal(line, column) {
          instance.revealLineInCenter(line);
          instance.setPosition({ lineNumber: line, column });
          instance.focus();
        },
      };
    }
    return () => {
      darkQuery?.removeEventListener("change", onTheme);
      sub.dispose();
      instance.dispose();
      model.dispose();
    };
    // Created once; later value changes are pushed in below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const model = editor.current?.getModel();
    if (model && model.getValue() !== value) model.setValue(value);
  }, [value]);

  useEffect(() => {
    const model = editor.current?.getModel();
    if (!model) return;
    monaco.editor.setModelMarkers(
      model,
      "tejun",
      markers.map((m) => ({ ...m, severity: monaco.MarkerSeverity.Error })),
    );
  }, [markers]);

  return <div className="editor" ref={container} />;
}
