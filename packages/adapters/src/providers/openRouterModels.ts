// Adapter: OpenRouter model catalog (ProviderModelCatalog port).
// GET /api/v1/models answers { data: [{ id, name, created, context_length,
// architecture, pricing, top_provider, ... }] } and needs no auth, so
// pickers can list models before an account (or key) exists.
// GET /api/v1/models/:id/endpoints lists serving providers for one model.

import type { ModelEndpoint, ProviderModel, ProviderModelCatalog } from "@swisscode/core";

export interface OpenRouterModelsOptions {
  baseUrl?: string; // default https://openrouter.ai
  fetchFn?: typeof fetch;
}

/** Non-transient shape: carries the HTTP status for cache/error policy. */
export class ModelCatalogError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ModelCatalogError";
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Pricing is decimal USD per token; pickers compare USD per 1M tokens. */
function perMillion(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value * 1e6 : undefined;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n * 1e6 : undefined;
  }
  return undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function parseModel(entry: unknown): ProviderModel | undefined {
  const rec = asRecord(entry);
  const id = str(rec?.["id"]);
  if (!id) return undefined;
  const model: ProviderModel = { id };
  const name = str(rec?.["name"]);
  if (name) model.name = name;
  const slash = id.indexOf("/");
  if (slash > 0) model.creator = id.slice(0, slash);
  const created = num(rec?.["created"]);
  if (created !== undefined) model.created = new Date(created * 1000).toISOString();
  const contextLength = num(rec?.["context_length"]);
  if (contextLength !== undefined) model.contextLength = contextLength;
  const modalities = asRecord(rec?.["architecture"])?.["input_modalities"];
  if (Array.isArray(modalities)) {
    const list = modalities.filter((m): m is string => typeof m === "string" && !!m);
    if (list.length > 0) model.inputModalities = list;
  }
  const pricing = asRecord(rec?.["pricing"]);
  const prompt = perMillion(pricing?.["prompt"]);
  if (prompt !== undefined) model.promptPerMillion = prompt;
  const completion = perMillion(pricing?.["completion"]);
  if (completion !== undefined) model.completionPerMillion = completion;
  const maxOut = num(asRecord(rec?.["top_provider"])?.["max_completion_tokens"]);
  if (maxOut !== undefined) model.maxCompletionTokens = maxOut;
  return model;
}

function parseEndpoint(entry: unknown): ModelEndpoint | undefined {
  const rec = asRecord(entry);
  const provider = str(rec?.["provider_name"]);
  if (!provider) return undefined;
  const endpoint: ModelEndpoint = { provider };
  const tag = str(rec?.["tag"]);
  if (tag) endpoint.tag = tag;
  const contextLength = num(rec?.["context_length"]);
  if (contextLength !== undefined) endpoint.contextLength = contextLength;
  const maxOut = num(rec?.["max_completion_tokens"]);
  if (maxOut !== undefined) endpoint.maxCompletionTokens = maxOut;
  const quantization = str(rec?.["quantization"]);
  if (quantization && quantization !== "unknown") endpoint.quantization = quantization;
  const pricing = asRecord(rec?.["pricing"]);
  const prompt = perMillion(pricing?.["prompt"]);
  if (prompt !== undefined) endpoint.promptPerMillion = prompt;
  const completion = perMillion(pricing?.["completion"]);
  if (completion !== undefined) endpoint.completionPerMillion = completion;
  const uptime = num(rec?.["uptime_last_1d"]);
  if (uptime !== undefined) endpoint.uptime1d = uptime;
  return endpoint;
}

export class OpenRouterModelCatalog implements ProviderModelCatalog {
  readonly providerId = "openrouter";

  constructor(private readonly options: OpenRouterModelsOptions = {}) {}

  private base(): string {
    return (this.options.baseUrl ?? "https://openrouter.ai").replace(/\/$/, "");
  }

  private async get(path: string): Promise<unknown> {
    const fetchFn = this.options.fetchFn ?? fetch;
    let res: Response;
    try {
      res = await fetchFn(`${this.base()}${path}`);
    } catch (err) {
      throw new ModelCatalogError(`OpenRouter request failed: ${(err as Error).message}`);
    }
    if (!res.ok) {
      throw new ModelCatalogError(`OpenRouter request failed: HTTP ${res.status}`, res.status);
    }
    return res.json().catch(() => ({}));
  }

  async listModels(): Promise<ProviderModel[]> {
    const body = asRecord(await this.get("/api/v1/models"));
    const data = body?.["data"];
    if (!Array.isArray(data)) throw new ModelCatalogError("OpenRouter model list was not a list.");
    const models: ProviderModel[] = [];
    for (const entry of data) {
      const model = parseModel(entry);
      if (model) models.push(model);
    }
    return models;
  }

  async listEndpoints(modelId: string): Promise<ModelEndpoint[]> {
    // Model ids are `author/slug` path segments; the route expects the raw
    // slash (percent-encoded %2F 404s). Ids are provider-issued slugs, safe.
    const body = asRecord(await this.get(`/api/v1/models/${modelId}/endpoints`));
    const endpoints = asRecord(body?.["data"])?.["endpoints"];
    if (!Array.isArray(endpoints)) {
      throw new ModelCatalogError("OpenRouter endpoints response was not a list.");
    }
    const out: ModelEndpoint[] = [];
    for (const entry of endpoints) {
      const endpoint = parseEndpoint(entry);
      if (endpoint) out.push(endpoint);
    }
    return out;
  }
}
