/**
 * The app's tools, in tab order. Each tool is a UI module (tools/<id>/ui.ts, see ./tool.ts)
 * plus, when it needs the library, a worker job (tools/<id>/job.ts, registered in ./jobs.ts).
 */
import type { Tool } from './tool.ts';
import { compressTool } from './tools/compress/ui.ts';

export const TOOLS: Tool[] = [compressTool];
