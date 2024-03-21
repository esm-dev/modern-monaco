export interface ICache {
  fetch(url: string | URL): Promise<Response>;
  query(key: string | URL): Promise<Response | null>;
}

export const cache: ICache;
export default cache;
