// Tejun syntax colouring for Monaco (a Monarch tokenizer), from the same
// keyword list as the compiler's lexer.

import { KEYWORDS } from "@tejun/compiler";

export const TEJUN_LANGUAGE_ID = "tejun";

export const tejunLanguage = {
  defaultToken: "",
  keywords: [...KEYWORDS],
  tokenizer: {
    root: [
      [/\/\/.*$/, "comment"],
      [/"[^"]*"?/, "string"],
      [/%[IQ][XW][\d.]+/, "number.hex"],
      [/\d+(\.\d+)?/, "number"],
      [/[A-Za-z_]\w*/, { cases: { "@keywords": "keyword", "@default": "identifier" } }],
      [/->|\.\.|<=|>=|==|!=|[<>@:;,.]/, "delimiter"],
      [/[{}()]/, "@brackets"],
    ],
  },
} as const;

export const tejunLanguageConfiguration = {
  comments: { lineComment: "//" },
  brackets: [
    ["{", "}"],
    ["(", ")"],
  ],
  autoClosingPairs: [
    { open: "{", close: "}" },
    { open: "(", close: ")" },
    { open: '"', close: '"' },
  ],
} as const;
