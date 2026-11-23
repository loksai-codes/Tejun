// T0107 name not usable in Structured Text.
//
// Signal names and the station name become IEC 61131-3 identifiers in the
// generated code. ST is case-insensitive and has its own reserved words, and
// the generator uses the `tj_` prefix for its own variables.

import type * as A from "../ast.js";
import type { CheckContext } from "./context.js";

/** IEC 61131-3 keywords, elementary types and standard function blocks (upper case). */
const ST_RESERVED: ReadonlySet<string> = new Set(
  `ACTION END_ACTION AND ANY ARRAY AT BOOL BY BYTE CASE END_CASE CONFIGURATION
  END_CONFIGURATION CONSTANT CTD CTU CTUD DATE DATE_AND_TIME DINT DO DT DWORD
  ELSE ELSIF EN ENO END_FOR END_FUNCTION END_FUNCTION_BLOCK END_IF END_PROGRAM
  END_REPEAT END_RESOURCE END_STEP END_STRUCT END_TRANSITION END_TYPE END_VAR
  END_WHILE EXIT F_EDGE F_TRIG FALSE FOR FROM FUNCTION FUNCTION_BLOCK IF
  INITIAL_STEP INT INTERVAL LINT LREAL LWORD MOD NON_RETAIN NOT OF ON OR
  PRIORITY PROGRAM R_EDGE R_TRIG READ_ONLY READ_WRITE REAL REPEAT RESOURCE
  RETAIN RETURN RS SINGLE SINT SR STEP STRING STRUCT TASK THEN TIME
  TIME_OF_DAY TO TOD TOF TON TP TRANSITION TRUE TYPE UDINT UINT ULINT UNTIL
  USINT VAR VAR_ACCESS VAR_CONFIG VAR_EXTERNAL VAR_GLOBAL VAR_IN_OUT VAR_INPUT
  VAR_OUTPUT VAR_TEMP WHILE WITH WORD WSTRING XOR`.split(/\s+/),
);

export function checkTargetNames(ctx: CheckContext): void {
  const names: A.Ident[] = [ctx.station.name, ...ctx.station.io.decls.map((d) => d.name)];
  const byFolded = new Map<string, A.Ident>();

  for (const name of names) {
    const upper = name.name.toUpperCase();
    if (ST_RESERVED.has(upper)) {
      ctx.error("T0107", name.span, {
        message: `\`${name.name}\` is a reserved word in Structured Text`,
        messageJa: `\`${name.name}\` は Structured Text の予約語です`,
        label: "reserved in Structured Text",
        help: `the generated PLC code would not compile; rename it, e.g. \`${name.name}_sig\``,
      });
      continue;
    }
    if (upper.startsWith("TJ_")) {
      ctx.error("T0107", name.span, {
        message: `names starting with \`tj_\` are reserved for generated code`,
        messageJa: `\`tj_\` で始まる名前は生成コード用に予約されています`,
        label: "reserved prefix",
        help: "rename it without the `tj_` prefix",
      });
      continue;
    }
    const first = byFolded.get(upper);
    if (first && first.name !== name.name) {
      ctx.error("T0107", name.span, {
        message: `\`${name.name}\` and \`${first.name}\` are the same name in Structured Text`,
        messageJa: `Structured Text では \`${name.name}\` と \`${first.name}\` は同じ名前です`,
        label: "differs only in case",
        help: `Structured Text ignores case; rename one of them (\`${first.name}\` is on line ${first.span.line})`,
      });
      continue;
    }
    byFolded.set(upper, name);
  }
}
