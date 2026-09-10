// Adapter: Meta model catalog (ProviderModelCatalog port).
// GET /v1/models answers { object: "list", data: [{ id, owned_by, ... }] }
// (OpenAI-style envelope) and needs the key, so pickers pass the stored
// account config through. The list carries no pricing or context lengths —
// models surface with ids only, and spend stays unknown rather than $0.

import type { ProviderModel, ProviderModelCatalog } from "@swisscode/core";
import { ModelCatalogError } from "./openRouterModels.js";

export interface MetaModelsOptions {
  baseUrl?: string; // default https://api.meta.ai
  fetchFn?: typeof fetch;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function parseModel(entry: unknown): ProviderModel | undefined {
  if (typeof entry !== "object" || entry === null) return undefined;
  const rec = entry as Record<string, unknown>;
  const id = str(rec["id"]);
  if (!id) return undefined;
  const model: ProviderModel = { id, name: id };
  const owner = str(rec["owned_by"]);
  if (owner) model.creator = owner;
  return model;
}

export class MetaModelCatalog implements ProviderModelCatalog {
  readonly providerId = "meta";

  constructor(private readonly options: MetaModelsOptions = {}) {}

  private base(): string {
    return (this.options.baseUrl ?? "https://api.meta.ai").replace(/\/$/, "");
  }

  async listModels(config?: Record<string, string>): Promise<ProviderModel[]> {
    const apiKey = (config?.["apiKey"] ?? "").trim();
    if (!apiKey) throw new ModelCatalogError("Meta model list needs an API key.");
    const fetchFn = this.options.fetchFn ?? fetch;
    let res: Response;
    try {
      res = await fetchFn(`${this.base()}/v1/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
    } catch (err) {
      throw new ModelCatalogError(`Meta request failed: ${(err as Error).message}`);
    }
    if (res.status === 401 || res.status === 403) {
      throw new ModelCatalogError("Meta key rejected (invalid or revoked).", res.status);
    }
    if (!res.ok) {
      throw new ModelCatalogError(`Meta request failed: HTTP ${res.status}`, res.status);
    }
    const body = (await res.json().catch(() => ({}))) as { data?: unknown };
    if (!Array.isArray(body.data)) throw new ModelCatalogError("Meta model list was not a list.");
    const models: ProviderModel[] = [];
    for (const entry of body.data) {
      const model = parseModel(entry);
      if (model) models.push(model);
    }
    return models;
  }
}
