export type Run = (action: () => Promise<void>) => Promise<void>;
export interface EventRecord {
  type: string;
  seq: number;
  data: Record<string, unknown>;
}
export interface Content {
  type: string;
  text?: string;
  name?: string;
  arguments?: unknown;
}
export interface CatalogEntry {
  id: string;
  title: string;
  description: string;
  defaults: Record<string, unknown>;
  fields: { name: string; type: string }[];
}
