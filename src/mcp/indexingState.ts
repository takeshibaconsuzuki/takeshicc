/**
 * Shared in-memory record of "what's the indexer doing for this workspace right now?"
 * — populated by `index_codebase` calls and by the AutoSync watcher; read by
 * `get_indexing_status` and by AutoSync to avoid stomping on a running job.
 */

export type IndexingState =
  | {
      phase: 'running';
      startedAt: number;
      progress: { phase: string; current: number; total: number; percentage: number };
      // Live counts updated as files / chunks are processed. `currentFiles`
      // is driven by the progress callback (during indexCodebase) or
      // initialized from the prior `completed` state (during a sync).
      // `currentChunks` is bumped from the vector-DB layer's insert/delete
      // hook so it tracks actual on-disk row count.
      currentFiles: number;
      currentChunks: number;
    }
  | {
      phase: 'completed';
      finishedAt: number;
      indexedFiles: number;
      totalChunks: number;
      status: 'completed' | 'limit_reached';
    }
  | { phase: 'failed'; finishedAt: number; error: string };

export const indexingStates = new Map<string, IndexingState>();

/**
 * Returns true if there's an in-flight index (or sync) for this workspace.
 * Callers use this to back off and retry rather than racing.
 */
export function isBusy(workspaceRoot: string): boolean {
  return indexingStates.get(workspaceRoot)?.phase === 'running';
}

/**
 * Bump `currentChunks` on the running state for this workspace. Wired up
 * from the vector-DB layer's insert / delete path so the count stays in
 * sync with the underlying table. No-op when nothing is running — chunks
 * inserted during e.g. createCollection's sample row don't count, and
 * stray deletes after a job finishes don't either.
 */
export function bumpRunningChunks(workspaceRoot: string, delta: number): void {
  const state = indexingStates.get(workspaceRoot);
  if (state?.phase !== 'running') return;
  state.currentChunks = Math.max(0, state.currentChunks + delta);
}

/** Test-only hook to reset the in-memory state map. */
export function __resetIndexingStatesForTest(): void {
  indexingStates.clear();
}
