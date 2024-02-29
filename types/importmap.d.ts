/** The import maps follow the spec at https://wicg.github.io/import-maps/. */
export interface ImportMap {
  $src?: string;
  $support?: boolean;
  $baseURL: string;
  imports: Record<string, string>;
  scopes: Record<string, ImportMap["imports"]>;
}
