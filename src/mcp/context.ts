import * as vscode from 'vscode';
import {
  Context,
  OpenAIEmbedding,
  type Embedding,
  type VectorDatabase,
} from '@zilliz/claude-context-core';
import { NullVectorDatabase } from './nullVectorDb';

export interface EmbeddingSettings {
  apiKey: string;
  baseURL: string;
  model: string;
}

export class EmbeddingNotConfiguredError extends Error {
  constructor() {
    super(
      'takeshicc: embedding API key is not set. Configure ' +
        '`takeshicc.embedding.apiKey` (and optionally `baseURL` / `model`) in VS Code settings.'
    );
    this.name = 'EmbeddingNotConfiguredError';
  }
}

/**
 * Read embedding settings from VS Code config. The apiKey is required; baseURL
 * and model fall back to the package.json defaults.
 */
export function readEmbeddingSettings(): EmbeddingSettings {
  const cfg = vscode.workspace.getConfiguration('takeshicc.embedding');
  return {
    apiKey: cfg.get<string>('apiKey', '').trim(),
    baseURL: cfg.get<string>('baseURL', 'https://api.openai.com/v1').trim(),
    model: cfg.get<string>('model', 'text-embedding-3-small').trim(),
  };
}

function buildEmbedding(settings: EmbeddingSettings): Embedding {
  if (!settings.apiKey) throw new EmbeddingNotConfiguredError();
  return new OpenAIEmbedding({
    apiKey: settings.apiKey,
    baseURL: settings.baseURL || undefined,
    model: settings.model,
  });
}

/**
 * Lazy, settings-driven Context factory. Rebuilds the Context whenever the
 * embedding settings change so a fresh API key / model takes effect without
 * a window reload.
 *
 * The vectorDatabase seam is currently filled with NullVectorDatabase — swap
 * it via setVectorDatabaseFactory() when the real backend lands.
 */
export class ContextFactory implements vscode.Disposable {
  private context: Context | null = null;
  private lastSettingsKey: string | null = null;
  private vectorDatabaseFactory: () => VectorDatabase = () => new NullVectorDatabase();
  private readonly configSub: vscode.Disposable;

  constructor() {
    this.configSub = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('takeshicc.embedding')) {
        this.context = null;
        this.lastSettingsKey = null;
      }
    });
  }

  /**
   * Replace the vector-database factory. Future Context instances will be
   * constructed with the new backend; the current cached Context is dropped.
   */
  setVectorDatabaseFactory(factory: () => VectorDatabase): void {
    this.vectorDatabaseFactory = factory;
    this.context = null;
    this.lastSettingsKey = null;
  }

  /**
   * Returns a Context built from current settings. Throws
   * EmbeddingNotConfiguredError if the API key is missing.
   */
  get(): Context {
    const settings = readEmbeddingSettings();
    const key = `${settings.apiKey ? 'set' : 'unset'}|${settings.baseURL}|${settings.model}`;
    if (this.context && this.lastSettingsKey === key) return this.context;
    this.context = new Context({
      embedding: buildEmbedding(settings),
      vectorDatabase: this.vectorDatabaseFactory(),
    });
    this.lastSettingsKey = key;
    return this.context;
  }

  dispose(): void {
    this.configSub.dispose();
    this.context = null;
  }
}
