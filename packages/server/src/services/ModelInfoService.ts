/**
 * Centralized cache for model metadata (especially context window sizes).
 *
 * Providers fetch model info from various sources (Ollama /api/show, SDK probes, etc.)
 * but that data was previously stranded in getAvailableModels() calls. This service
 * caches it so readers and routes can look up context windows without re-fetching.
 *
 * Sync getContextWindow() checks cache first, falls back to the shared heuristic.
 *
 * **Persistence:** Cache is also written to `<dataDir>/model-context-windows.json`
 * (debounced) so context window values discovered at runtime (e.g. opus[1m] = 1M)
 * survive server restarts. Without persistence, the meter would revert to the
 * 200K heuristic after every restart until the live Process re-discovers the
 * true window via `result.modelUsage` or `initializationResult()`.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  type ModelInfo,
  type ProviderName,
  getModelContextWindow,
} from "@yep-anywhere/shared";
import { getProvider } from "../sdk/providers/index.js";

const CURRENT_VERSION = 1;
const STORAGE_FILENAME = "model-context-windows.json";

interface StoredState {
  version: number;
  /** Map of "provider:model" → contextWindow tokens */
  contextWindows: Record<string, number>;
}

export interface ModelInfoServiceOptions {
  /** When provided, the cache is persisted to <dataDir>/model-context-windows.json. */
  dataDir?: string;
}

export class ModelInfoService {
  /** (provider:modelId) → contextWindow */
  private contextWindows = new Map<string, number>();
  private dataDir?: string;
  private filePath?: string;
  private initialized = false;
  private savePromise: Promise<void> | null = null;
  private pendingSave = false;

  constructor(options: ModelInfoServiceOptions = {}) {
    this.dataDir = options.dataDir;
    if (this.dataDir) {
      this.filePath = path.join(this.dataDir, STORAGE_FILENAME);
    }
  }

  /**
   * Load persisted cache from disk. Safe to call without dataDir (no-op).
   * Failures are logged and the cache stays empty — never throws.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    if (!this.dataDir || !this.filePath) return;

    try {
      await fs.mkdir(this.dataDir, { recursive: true });
      const content = await fs.readFile(this.filePath, "utf-8");
      const parsed = JSON.parse(content) as Partial<StoredState>;

      if (
        parsed &&
        parsed.version === CURRENT_VERSION &&
        parsed.contextWindows
      ) {
        for (const [key, value] of Object.entries(parsed.contextWindows)) {
          if (typeof value === "number" && value > 0) {
            this.contextWindows.set(key, value);
          }
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(
          "[ModelInfoService] Failed to load persisted cache, starting empty:",
          error,
        );
      }
    }
  }

  /**
   * Get context window for a model (sync).
   * Checks cache first, falls back to shared heuristic.
   */
  getContextWindow(model: string | undefined, provider?: ProviderName): number {
    if (model && provider) {
      const cached = this.contextWindows.get(`${provider}:${model}`);
      if (cached !== undefined) return cached;
    }
    return getModelContextWindow(model, provider);
  }

  /**
   * Return the cached contextWindow if known, otherwise undefined.
   * Use this when the caller needs to distinguish "we observed this" from
   * "we're falling back to the heuristic".
   */
  getCachedContextWindow(
    model: string | undefined,
    provider?: ProviderName,
  ): number | undefined {
    if (!model || !provider) return undefined;
    return this.contextWindows.get(`${provider}:${model}`);
  }

  /**
   * Populate cache from a provider's getAvailableModels().
   * Call at startup and when sessions are created. Failures are logged, not thrown.
   */
  async warmProvider(providerName: ProviderName): Promise<void> {
    const provider = getProvider(providerName);
    if (!provider) return;

    try {
      const models = await provider.getAvailableModels();
      this.ingestModels(providerName, models);
    } catch {
      // Best-effort — fallback to heuristic
    }
  }

  /**
   * Ingest model list into the cache.
   * Called by warmProvider() and also by the providers route when it already
   * has fresh model data (avoids redundant fetches).
   */
  ingestModels(providerName: ProviderName, models: ModelInfo[]): void {
    let changed = false;
    for (const m of models) {
      if (m.contextWindow) {
        const key = `${providerName}:${m.id}`;
        if (this.contextWindows.get(key) !== m.contextWindow) {
          this.contextWindows.set(key, m.contextWindow);
          changed = true;
        }
      }
    }
    if (changed) this.schedulePersist();
  }

  /**
   * Record a context window discovered at runtime
   * (e.g. from model_context_window in Codex SDK messages, or
   * result.modelUsage in Claude SDK messages).
   */
  recordContextWindow(
    model: string,
    contextWindow: number,
    provider?: ProviderName,
  ): void {
    const key = provider ? `${provider}:${model}` : model;
    if (this.contextWindows.get(key) === contextWindow) return;
    this.contextWindows.set(key, contextWindow);
    this.schedulePersist();
  }

  /**
   * Trigger a debounced save. Quietly does nothing if persistence is not
   * configured (no dataDir).
   */
  private schedulePersist(): void {
    if (!this.filePath) return;
    // Fire and forget; save() handles its own debouncing.
    void this.save().catch((err) => {
      console.error("[ModelInfoService] persist error:", err);
    });
  }

  private async save(): Promise<void> {
    if (!this.filePath) return;
    if (this.savePromise) {
      this.pendingSave = true;
      return;
    }

    this.savePromise = this.doSave();
    try {
      await this.savePromise;
    } finally {
      this.savePromise = null;
    }

    if (this.pendingSave) {
      this.pendingSave = false;
      await this.save();
    }
  }

  private async doSave(): Promise<void> {
    if (!this.filePath) return;
    const state: StoredState = {
      version: CURRENT_VERSION,
      contextWindows: Object.fromEntries(this.contextWindows.entries()),
    };
    const content = JSON.stringify(state, null, 2);
    await fs.writeFile(this.filePath, content, "utf-8");
  }
}
