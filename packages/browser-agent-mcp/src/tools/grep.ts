import { z } from 'zod/v4'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { trackToolCall } from '../activity-bus.js'
import {
  GREP_DEFAULT_MAX,
  GREP_HARD_MAX,
  STDOUT_CAP,
  truncateOutput,
} from '../limits.js'
import { grepFiles } from '../ops/files.js'

export function registerGrepTool(server: McpServer): void {
  server.registerTool(
    'Grep',
    {
      description:
        'Search file contents under the workspace. Prefer a subdirectory via path and a file glob. Prefer this over Bash. Results are capped for speed.',
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
      },
      inputSchema: {
        pattern: z.string().describe('Regex/search pattern'),
        path: z
          .string()
          .optional()
          .describe('File or directory to search (prefer a subdirectory)'),
        glob: z.string().optional().describe('Optional glob filter, e.g. *.ts'),
        case_insensitive: z.boolean().optional().describe('Case-insensitive search'),
        max_results: z
          .number()
          .int()
          .min(1)
          .max(GREP_HARD_MAX)
          .optional()
          .describe(`Max matching lines (default ${GREP_DEFAULT_MAX}, max ${GREP_HARD_MAX})`),
      },
    },
    async ({ pattern, path, glob, case_insensitive, max_results }) =>
      trackToolCall(
        'Grep',
        {
          argsSummary: path ? `${pattern} in ${path}` : pattern,
          paths: path ? [path] : [],
          args: { pattern, path, glob, case_insensitive, max_results },
        },
        async () => {
          try {
            // Shared with the local HTTP route (see ops/files.ts). The two used
            // to carry separate ripgrep and Node-fallback implementations, so
            // the caps and the workspace confinement could drift apart.
            const { matches, truncated } = await grepFiles({
              pattern,
              path,
              glob,
              caseInsensitive: case_insensitive,
              maxResults: max_results,
            })

            if (matches.length === 0) {
              return { content: [{ type: 'text' as const, text: 'No matches.' }] }
            }

            const body = matches.map((m) => `${m.path}:${m.line}:${m.text}`).join('\n')
            const suffix = truncated ? `\n\n…capped at ${matches.length} matches` : ''
            return {
              content: [
                {
                  type: 'text' as const,
                  text: truncateOutput(body + suffix, STDOUT_CAP, 'grep'),
                },
              ],
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            const hint = error instanceof SyntaxError ? ' (invalid pattern)' : ''
            return {
              isError: true,
              content: [{ type: 'text' as const, text: `Grep failed: ${message}${hint}` }],
            }
          }
        },
      ),
  )
}
