export interface FormatOptions {
  tabSize?: number;
  insertSpaces?: boolean;
  trimTrailingWhitespace?: boolean;
  insertFinalNewline?: boolean;
  trimFinalNewlines?: boolean;

  // HTML
  html?: {
    contentUnformatted?: string;
    endWithNewline?: boolean;
    extraLiners?: string;
    indentEmptyLines?: boolean;
    indentHandlebars?: boolean;
    indentInnerHtml?: boolean;
    indentScripts?: "keep" | "separate" | "normal";
    insertSpaces?: boolean;
    maxPreserveNewLines?: number;
    preserveNewLines?: boolean;
    tabSize?: number;
    templating?: boolean;
    unformatted?: string;
    unformattedContentDelimiter?: string;
    wrapAttributes?:
      | "auto"
      | "force"
      | "force-aligned"
      | "force-expand-multiline"
      | "aligned-multiple"
      | "preserve"
      | "preserve-aligned";
    wrapAttributesIndentSize?: number;
    wrapLineLength?: number;
  };

  // CSS
  css?: {
    /** indentation size. Default: 4 */
    tabSize?: number;
    /** Whether to use spaces or tabs */
    insertSpaces?: boolean;
    /** end with a newline: Default: false */
    insertFinalNewline?: boolean;
    /** separate selectors with newline (e.g. "a,\nbr" or "a, br"): Default: true */
    newlineBetweenSelectors?: boolean;
    /** add a new line after every css rule: Default: true */
    newlineBetweenRules?: boolean;
    /** ensure space around selector separators:  '>', '+', '~' (e.g. "a>b" -> "a > b"): Default: false */
    spaceAroundSelectorSeparator?: boolean;
    /** put braces on the same line as rules (`collapse`), or put braces on own line, Allman / ANSI style (`expand`). Default `collapse` */
    braceStyle?: "collapse" | "expand";
    /** whether existing line breaks before elements should be preserved. Default: true */
    preserveNewLines?: boolean;
    /** maximum number of line breaks to be preserved in one chunk. Default: unlimited */
    maxPreserveNewLines?: number;
    /** maximum amount of characters per line (0/undefined = disabled). Default: disabled. */
    wrapLineLength?: number;
    /** add indenting whitespace to empty lines. Default: false */
    indentEmptyLines?: boolean;
  };

  // JSON
  json?: {
    insertFinalNewline?: boolean;
    insertSpaces?: boolean;
    keepLines?: boolean;
    tabSize?: number;
    trimFinalNewlines?: boolean;
    trimTrailingWhitespace?: boolean;
  };

  // TypeScript
  typescript?: {
    indentMultiLineObjectLiteralBeginningOnBlankLine?: boolean;
    indentSwitchCase?: boolean;
    insertSpaceAfterCommaDelimiter?: boolean;
    insertSpaceAfterConstructor?: boolean;
    insertSpaceAfterFunctionKeywordForAnonymousFunctions?: boolean;
    insertSpaceAfterKeywordsInControlFlowStatements?: boolean;
    insertSpaceAfterOpeningAndBeforeClosingEmptyBraces?: boolean;
    insertSpaceAfterOpeningAndBeforeClosingJsxExpressionBraces?: boolean;
    insertSpaceAfterOpeningAndBeforeClosingNonemptyBraces?: boolean;
    insertSpaceAfterOpeningAndBeforeClosingNonemptyBrackets?: boolean;
    insertSpaceAfterOpeningAndBeforeClosingNonemptyParenthesis?: boolean;
    insertSpaceAfterOpeningAndBeforeClosingTemplateStringBraces?: boolean;
    insertSpaceAfterSemicolonInForStatements?: boolean;
    insertSpaceAfterTypeAssertion?: boolean;
    insertSpaceBeforeAndAfterBinaryOperators?: boolean;
    insertSpaceBeforeFunctionParenthesis?: boolean;
    insertSpaceBeforeTypeAnnotation?: boolean;
    placeOpenBraceOnNewLineForControlBlocks?: boolean;
    placeOpenBraceOnNewLineForFunctions?: boolean;
    semicolons?: "ignore" | "insert" | "remove";
    baseIndentSize?: number;
    convertTabsToSpaces?: boolean;
    indentSize?: number;
    indentStyle?: number;
    newLineCharacter?: string;
    tabSize?: number;
    trimTrailingWhitespace?: boolean;
  };
}
