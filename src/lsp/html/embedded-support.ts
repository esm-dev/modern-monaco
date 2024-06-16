/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Copyright (c) Je Xia <i@jex.me>
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { LanguageService, Position, TextDocument, TokenType } from "vscode-html-languageservice";

export interface HTMLDocumentRegions {
  readonly regions: readonly EmbeddedRegion[];
  readonly importedScripts: readonly ImportedScript[];
  getEmbeddedDocument(languageId: string, ignoreAttributeValues?: boolean): string | null;
  getEmbeddedLanguages(ignoreAttributeValues?: boolean): string[];
  getEmbeddedLanguageAtPosition(position: Position): string | undefined;
  hasEmbeddedLanguage(languageId: string, ignoreAttributeValues?: boolean): boolean;
}

export interface EmbeddedRegion {
  start: number;
  end: number;
  languageId?: string;
  attributeValue?: boolean;
}

export interface ImportedScript {
  start: number;
  end: number;
  src: string;
}

const cache = new Map<string, [EmbeddedRegion[], ImportedScript[], version: number, expries: number]>();

export function getDocumentRegions(languageService: LanguageService, document: TextDocument): HTMLDocumentRegions {
  const regions: EmbeddedRegion[] = [];
  const importedScripts: ImportedScript[] = [];
  const cacheKey = document.uri;
  const cachedRegions = cache.get(document.uri);

  if (cachedRegions && cachedRegions[2] === document.version && cachedRegions[3] > Date.now()) {
    regions.push(...cachedRegions[0]);
    importedScripts.push(...cachedRegions[1]);
  } else {
    const scanner = languageService.createScanner(document.getText());

    let lastTagName: string = "";
    let lastAttributeName: string | null = null;
    let languageIdFromType: string | undefined = undefined;
    let token = scanner.scan();

    while (token !== TokenType.EOS) {
      switch (token) {
        case TokenType.StartTag:
          lastTagName = scanner.getTokenText();
          lastAttributeName = null;
          languageIdFromType = "javascript";
          break;
        case TokenType.Styles:
          regions.push({
            languageId: "css",
            start: scanner.getTokenOffset(),
            end: scanner.getTokenEnd(),
          });
          break;
        case TokenType.Script:
          regions.push({
            languageId: languageIdFromType,
            start: scanner.getTokenOffset(),
            end: scanner.getTokenEnd(),
          });
          break;
        case TokenType.AttributeName:
          lastAttributeName = scanner.getTokenText();
          break;
        case TokenType.AttributeValue:
          if (lastAttributeName === "src" && lastTagName.toLowerCase() === "script") {
            let src = scanner.getTokenText();
            if (src[0] === "'" || src[0] === "\"") {
              src = src.slice(1, -1);
            }
            importedScripts.push({
              start: scanner.getTokenOffset(),
              end: scanner.getTokenEnd(),
              src,
            });
          } else if (lastAttributeName === "type" && lastTagName.toLowerCase() === "script") {
            const tokenText = scanner.getTokenText();
            if (/["'](module|(text|application)\/(java|ecma)script|text\/babel)["']/.test(tokenText)) {
              languageIdFromType = "javascript";
            } else if (/["']importmap["']/.test(tokenText)) {
              languageIdFromType = "importmap";
            } else {
              languageIdFromType = undefined;
            }
          } else {
            const attributeLanguageId = getAttributeLanguage(lastAttributeName!);
            if (attributeLanguageId) {
              let start = scanner.getTokenOffset();
              let end = scanner.getTokenEnd();
              const firstChar = document.getText()[start];
              if (firstChar === "'" || firstChar === "\"") {
                start++;
                end--;
              }
              regions.push({
                languageId: attributeLanguageId,
                start,
                end,
                attributeValue: true,
              });
            }
          }
          lastAttributeName = null;
          break;
      }
      token = scanner.scan();
    }

    // cache the regions with a 30s expiry
    cache.set(cacheKey, [regions, importedScripts, document.version, Date.now() + 30 * 1000]);
  }

  return {
    regions,
    importedScripts,
    getEmbeddedDocument: (languageId, ignoreAttributeValues) => getEmbeddedDocument(document, regions, languageId, ignoreAttributeValues),
    getEmbeddedLanguages: (ignoreAttributeValues) => getEmbeddedLanguages(regions, ignoreAttributeValues),
    getEmbeddedLanguageAtPosition: (position) => getEmbeddedLanguageAtPosition(document, regions, position),
    hasEmbeddedLanguage: (languageId, ignoreAttributeValues) =>
      regions.some(r => r.languageId === languageId && (!ignoreAttributeValues || !r.attributeValue)),
  };
}

function getEmbeddedLanguages(regions: EmbeddedRegion[], ignoreAttributeValues?: boolean): string[] {
  const result = [];
  for (const { languageId, attributeValue } of regions) {
    if (languageId && (!ignoreAttributeValues || !attributeValue) && result.indexOf(languageId) === -1) {
      result.push(languageId);
    }
  }
  return result;
}

function getEmbeddedLanguageAtPosition(
  document: TextDocument,
  regions: EmbeddedRegion[],
  position: Position,
): string | undefined {
  const offset = document.offsetAt(position);
  for (const region of regions) {
    if (region.start > offset) {
      break;
    }
    if (offset <= region.end) {
      return region.languageId;
    }
  }
}

function getEmbeddedDocument(
  document: TextDocument,
  contents: EmbeddedRegion[],
  languageId: string,
  ignoreAttributeValues: boolean,
): string | null {
  const docText = document.getText();
  let currentPos = 0;
  let result = "";
  let lastSuffix = "";
  let hasAny = false;
  for (const c of contents) {
    if (c.languageId === languageId && (!ignoreAttributeValues || !c.attributeValue)) {
      result = substituteWithWhitespace(
        result,
        currentPos,
        c.start,
        docText,
        lastSuffix,
        getPrefix(c),
      );
      result += updateContent(c, docText.substring(c.start, c.end));
      currentPos = c.end;
      lastSuffix = getSuffix(c);
      hasAny = true;
    }
  }
  if (!hasAny) {
    return null;
  }
  return result + lastSuffix;
}

function getPrefix(c: EmbeddedRegion) {
  if (c.attributeValue) {
    switch (c.languageId) {
      case "css":
        return "__{";
    }
  }
  return "";
}

function getSuffix(c: EmbeddedRegion) {
  if (c.attributeValue) {
    switch (c.languageId) {
      case "css":
        return "}";
      case "javascript":
        return ";";
    }
  }
  return "";
}

function updateContent(c: EmbeddedRegion, content: string): string {
  if (!c.attributeValue && c.languageId === "javascript") {
    return content.replace(`<!--`, `/* `).replace(`-->`, ` */`);
  }
  return content;
}

function substituteWithWhitespace(
  result: string,
  start: number,
  end: number,
  oldContent: string,
  before: string,
  after: string,
) {
  result += before;
  let accumulatedWS = -before.length; // start with a negative value to account for the before string
  for (let i = start; i < end; i++) {
    const ch = oldContent[i];
    // only write new lines, skip the whitespace
    if (ch === "\n" || ch === "\r") {
      accumulatedWS = 0;
      result += ch;
    } else {
      accumulatedWS++;
    }
  }
  result = append(result, " ", accumulatedWS - after.length);
  result += after;
  return result;
}

function append(result: string, str: string, n: number): string {
  while (n > 0) {
    if (n & 1) {
      result += str;
    }
    n >>= 1;
    str += str;
  }
  return result;
}

function getAttributeLanguage(attributeName: string): string | null {
  if (attributeName === "style") {
    return "css";
  }
  if (attributeName.startsWith("on") && /^[a-z]+$/.test(attributeName.slice(2))) {
    return "javascript";
  }
  return null;
}
