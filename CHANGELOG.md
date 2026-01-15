# Changelog

### v0.3.7

- Add support for multiple themes (#53)
- Deprecate `theme` option in favor of `defaultTheme` and `themes` (#53)
- Update `shiki` to 3.21.0
- Update `tm-grammars` to 1.28.0
- Update `tm-themes` to 1.10.15
- Update `vscode-css-languageservice` to 6.3.9
- Update `vscode-html-languageservice` to 5.6.1
- Update `vscode-json-languageservice` to 5.7.1

## v0.3.6

- Update `sideEffects: ["dist/index.mjs"]` in package.json (#48)
- Update import statements to use `webpackIgnore` annotation (#47)

## v0.3.5

- Add `dataProviders` option to `LSPConfig.css`
- Add `hideEndTagSuggestions` option to `LSPConfig.html`
- Update options of `LSPConfig.json`
  ```ts
  export interface JSONLanguageConfig {
    /** By default, the validator will return syntax and semantic errors. Set to false to disable the validator. */
    validate?: boolean;
    /** Defines whether comments are allowed or not. Default is disallowed. */
    allowComments?: boolean;
    /** A list of known schemas and/or associations of schemas to file names. */
    schemas?: JSONSchemaSource[];
    /** The severity of reported comments. Default is "error". */
    comments?: SeverityLevel;
    /** The severity of reported trailing commas. Default is "error". */
    trailingCommas?: SeverityLevel;
    /** The severity of problems from schema validation. Default is "warning". */
    schemaValidation?: SeverityLevel;
    /** The severity of problems that occurred when resolving and loading schemas. Default is "warning". */
    schemaRequest?: SeverityLevel;
  }
  ```

## v0.3.4

- Use bun as the scripts runner
- Validate and normalize `theme` option
- Fix normalizeColor function (close #45)

## v0.3.3

- Fix `theme` option for `init` funtion
- Fix creating nested directories using default FS (#43 by @xkcm)

## v0.3.2

- Upgrade shiki to 3.17.0
- Fix typescript import from CDN

## v0.3.1

- lsp: Fix "Cannot destructure property 'editor' of 'monaco' as it is undefined."

## v0.3.0

- Fix CDN loading
- Upgrade monaco-editor-core to 0.55.1
- Fix custom theme names and custom theme objects (#42 by @hybridherbst)

## v0.2.2

- Fix missing colon in protocol check (#30 by @ayu-exorcist)
- Loading monaco-editor-core and builtin lsp from esm.sh CDN (#28)

## v0.2.1

- Fix package exports.

## v0.2.0

- lsp: Fix path/url complete (#16)
- shiki: load plaintext TMGrammer (#19 by @undefined-moe)
- workspace: allow file quick view without writing to fs (#20 by @undefined-moe)
- chore: fix production usage with bundlers (fix #14, fix #15) (#22 by @undefined-moe)
- chore: Upgrade monaco-editor-core to 0.53.0 (#25)

## v0.1.9

- Fix builtin syntaxes loading
- Fix tm-grammars registry
- Upgrade shiki to 3.12.2

## v0.1.8

- Prevent duplicate custom element registration and model creation for better HMR DX (#9 by @rhzone)

## v0.1.7

- Fix shiki theme loader

## v0.1.6

- Fix node.js panic with invalid theme-id

## v0.1.5

- Fix SSR code sync on client side
- Fix SSR with `fontFamily` option
- Use `file://` protocol for unnamed model
- Add SSR demo link by @pi0: https://modern-monaco-demo.vercel.app/

## v0.1.4

- Fix `RenderOptions` types

## v0.1.3

- types(**BREAKING**): rename customFs to customFS
- types: remove server option of WorkspaceInit

## v0.1.2

- Fix workspace file initiating for custom file system
- Upgrade shiki to 3.11.0

## v0.1.1

- feat: Add customFs option for Workspace (#5 by @yzuyr)
  ```ts
  import { lazy, type FileSystem, Workspace } from "modern-monaco";

  class CustomFileSystem implements FileSystem {
    // Custom FileSystem implementation
  }

  const workspace = new Workspace({
    customFS: new CustomFileSystem(),
  });
  ```
- feat: Add standalone state db

## v0.1.0

first release
