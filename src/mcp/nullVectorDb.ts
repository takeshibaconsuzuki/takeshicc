import type {
  VectorDatabase,
  VectorDocument,
  SearchOptions,
  VectorSearchResult,
  HybridSearchRequest,
  HybridSearchOptions,
  HybridSearchResult,
} from '@zilliz/claude-context-core';

/**
 * Placeholder VectorDatabase that fails fast with a clear error. The plan is to
 * inject a real implementation (custom backend, not Milvus) later — until then,
 * Context tools surface "vector DB not configured" instead of crashing with an
 * NPE deep inside the indexing pipeline.
 */
export class NullVectorDatabase implements VectorDatabase {
  private fail(): never {
    throw new Error(
      'takeshicc: no vector database is configured. Inject a VectorDatabase ' +
        'implementation via the context factory before using claude-context tools.'
    );
  }

  async createCollection(): Promise<void> {
    this.fail();
  }
  async createHybridCollection(): Promise<void> {
    this.fail();
  }
  async dropCollection(): Promise<void> {
    this.fail();
  }
  async hasCollection(): Promise<boolean> {
    return false;
  }
  async listCollections(): Promise<string[]> {
    return [];
  }
  async insert(_collectionName: string, _documents: VectorDocument[]): Promise<void> {
    this.fail();
  }
  async insertHybrid(_collectionName: string, _documents: VectorDocument[]): Promise<void> {
    this.fail();
  }
  async search(
    _collectionName: string,
    _queryVector: number[],
    _options?: SearchOptions
  ): Promise<VectorSearchResult[]> {
    this.fail();
  }
  async hybridSearch(
    _collectionName: string,
    _searchRequests: HybridSearchRequest[],
    _options?: HybridSearchOptions
  ): Promise<HybridSearchResult[]> {
    this.fail();
  }
  async delete(_collectionName: string, _ids: string[]): Promise<void> {
    this.fail();
  }
  async query(): Promise<Record<string, unknown>[]> {
    return [];
  }
  async getCollectionDescription(): Promise<string> {
    return '';
  }
  async checkCollectionLimit(): Promise<boolean> {
    return true;
  }
  async getCollectionRowCount(): Promise<number> {
    return -1;
  }
}
