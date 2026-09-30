/** What a tool in the app provides. See ./tools.ts for the registry. */
import type { WorkerClient } from './client.ts';
import type { MemoryMonitor } from './memory.ts';

export interface ToolContext {
  /** Runs jobs in the shared Web Worker. */
  worker: WorkerClient;
  memory: MemoryMonitor;
  /** Announce a short status message to screen readers (polite). */
  announce(message: string): void;
  /** Whether the browser can stream a result to a file on disk (showSaveFilePicker). */
  canSaveToDisk: boolean;
  /** Ask for a file to save to; null if the user cancelled. Must be called from a user gesture. */
  pickSaveFile(suggestedName: string): Promise<FileSystemFileHandle | null>;
}

export interface Tool {
  /** Stable id: the URL hash (#compress) and the prefix of the tool's element ids. */
  id: string;
  /** Tab label. */
  label: string;
  /** SVG icon markup (decorative). */
  icon?: string;
  /** One-sentence description shown at the top of the panel. */
  summary: string;
  /** Build the tool's UI inside `panel`. Called once, the first time the tab is shown. */
  mount(panel: HTMLElement, ctx: ToolContext): void;
}
