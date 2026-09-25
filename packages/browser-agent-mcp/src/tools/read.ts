import { z } from 'zod/v4'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { trackToolCall } from '../activity-bus.js'
import { READ_DEFAULT_LIMIT, READ_HARD_MAX } from '../limits.js'
import { readFileWindow } from '../ops/files.js'

export function registerReadTool(server: McpServer): void {
  server.registerTool(
    'Read',
    {
      description:
        'Read a file from the allowlisted workspace. Prefer offset/limit for large files. Default window is capped for speed/context size.',
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
      },
      inputSchema: {
        path: z.string().describe('File path relative to workspace root'),
        offset: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('1-based start line (optional)'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(READ_HARD_MAX)
          .optional()
          .describe(`Max lines to return (default ${READ_DEFAULT_LIMIT}, max ${READ_HARD_MAX})`),
      },
    },
    async ({ path, offset, limit }) =>
      trackToolCall(
        'Read',
        {
          argsSummary: path,
          paths: [path],
          args: { path, offset, limit },
        },
        async () => {
          try {
            // Shared with the local HTTP route (see ops/files.ts) so the
            // workspace confinement cannot hold in one and not the other.
            const window = await readFileWindow({ path, offset, limit })
            const numbered = window.content
              .split('\n')
              .map((line, i) => `${String(window.startLine + i).padStart(6)}\t${line}`)
              .join('\n')
            return {
              content: [
                {
                  type: 'text' as const,
                  text:
                    `File: ${window.path} (lines ${window.startLine}-${window.endLine} of ${window.totalLines})\n\n` +
                    numbered +
                    (window.truncated
                      ? `\n\n…truncated — pass offset=${window.endLine + 1} and limit to continue`
                      : ''),
                },
              ],
            }
          } catch (error) {
            return {
              isError: true,
              content: [
                {
                  type: 'text' as const,
                  text: `Read failed: ${error instanceof Error ? error.message : String(error)}`,
                },
              ],
            }
          }
        },
      ),
  )
}
