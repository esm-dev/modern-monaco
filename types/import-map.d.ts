/** The import maps follow the spec at https://wicg.github.io/import-maps/. */
export interface ImportMap {
  $src?: string;
  $support?: boolean;
  $baseURL: string;
  imports: Record<string, string>;
  scopes: Record<string, Record<string, string>>;
}

export function createBlankImportMap(): ImportMap;
export function isBlankImportMap(importMap: ImportMap): boolean;
export function importMapFrom(v: any, baseURL?: string): ImportMap;
export function parseImportMapFromJson(json: string, baseURL?: string): ImportMap;
export function parseImportMapFromHtml(html: string, baseURL?: string): ImportMap;
export function resolve(importMap: ImportMap, specifier: string, containingFile: string): string;
