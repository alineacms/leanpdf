/** What a tool in the toolbox provides and gets. See ./tools.ts for the registry. */
import type { WorkerClient } from './client.ts';
import type { DocStore } from './document.ts';

export interface ToolContext {
  /** Runs jobs in the shared Web Worker. */
  worker: WorkerClient;
  /** The open document; tools follow it with `doc.subscribe`. */
  doc: DocStore;
  /** Scroll the viewer to a page (0-based). */
  goToPage(page: number): void;
  /** Open a result (a PDF the tool made) in the viewer, as the new document. */
  openResult(blob: Blob, name: string): void;
  /** Announce a short status message to screen readers (polite). */
  announce(message: string): void;
  /** Whether the browser can stream a result to a file on disk (showSaveFilePicker). */
  canSaveToDisk: boolean;
  /** Ask for a file to save to; null if the user cancelled. Must be called from a user gesture. */
  pickSaveFile(suggestedName: string): Promise<FileSystemFileHandle | null>;
}

export interface Tool {
  /** Stable id: the prefix of the tool's element ids. */
  id: string;
  /** Section heading. */
  label: string;
  /** SVG icon markup (decorative). */
  icon: string;
  /** One line under the heading. */
  summary: string;
  /** Build the tool's UI inside `section`. Called once. */
  mount(section: HTMLElement, ctx: ToolContext): void;
}
