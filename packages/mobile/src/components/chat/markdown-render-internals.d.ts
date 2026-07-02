// Ambient declarations for the test-only imports in
// markdown-image-render.test.tsx. The markdown rendering regression test parses
// with the real markdown-it (what the library wraps) and drives the library's
// `parser` + `AstRenderer` directly from their `/src/lib/*` paths — bypassing
// the package-root mock without dragging the full renderRules chain through it.
// None of these ship type declarations (and @types/markdown-it isn't
// installed), so type them as `any`; the test asserts on the produced element
// tree at runtime, not on module types.
declare module "markdown-it";
declare module "react-native-markdown-display/src/lib/AstRenderer.js";
declare module "react-native-markdown-display/src/lib/parser.js";
