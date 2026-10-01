/**
 * The toolbox, in order. Each tool is a UI module (tools/<id>/ui.ts, see ./tool.ts) working on
 * the open document, plus, when it needs the library, a worker job (tools/<id>/job.ts,
 * registered in ./jobs.ts). Shared building blocks are in ./kit.ts.
 */
import type { Tool } from './tool.ts';
import { compressTool } from './tools/compress/ui.ts';
import { editTool } from './tools/edit/ui.ts';
import { inspectTool } from './tools/inspect/ui.ts';
import { mergeTool } from './tools/merge/ui.ts';
import { textTool } from './tools/text/ui.ts';

export const TOOLS: Tool[] = [inspectTool, compressTool, editTool, mergeTool, textTool];
