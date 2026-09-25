import { glob } from 'node:fs/promises'
import { z } from 'zod/v4'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { trackToolCall } from '../activity-bus.js'
import { GLOB_MAX_MATCHES, shouldSkipDirName } from '../limits.js'
import { getWorkspaceRoot, resolveInWorkspace, toWorkspaceRelative } from '../paths.js'

export function registerGlobTool(server: McpServer): void {
  server.registerTool(
    'Glob',
    {
      description:
        'Find files under the workspace matching a glob pattern (e.g. **/*.ts). Prefer a subdirectory via path. Skips node_modules/.git/dist and similar. Caps results for speed.',
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
      },
      inputSchema: {
        pattern: z.string().describe('Glob pattern'),
        path: z
          .string()
          .optional()
          .describe('Subdirectory to search from (relative to workspace) — prefer this over scanning the whole workspace'),
        max_results: z
          .number()
          .int()
          .min(1)
          .max(GLOB_MAX_MATCHES)
          .optional()
          .describe(`Max paths to return (default ${GLOB_MAX_MATCHES})`),
      },
    },
    async ({ pattern, path, max_results }) =>
      trackToolCall(
        'Glob',
        {
          argsSummary: path ? `${pattern} in ${path}` : pattern,
          paths: path ? [path] : [],
          args: { pattern, path, max_results },
        },
        async () => {
          try {
            const root = path
              ? resolveInWorkspace(path, { mustExist: true })
              : getWorkspaceRoot()
            const cap = max_results ?? GLOB_MAX_MATCHES
            const matches: string[] = []
            for await (const entry of glob(pattern, {
              cwd: root,
              exclude: (name) => shouldSkipDirName(name),
            })) {
              if (typeof entry !== 'string') continue
              if (entry.endsWith('/')) continue
              // Also skip if any path segment is a heavy dir
              if (entry.split(/[/\\]/).some((seg) => shouldSkipDirName(seg))) continue
              const abs = resolveInWorkspace(
                path ? `${path.replace(/\/$/, '')}/${entry}` : entry,
                { mustExist: false },
              )
              matches.push(toWorkspaceRelative(abs))
              if (matches.length >= cap) break
            }
            matches.sort()
            return {
              content: [
                {
                  type: 'text' as const,
                  text:
                    matches.length === 0
                      ? 'No files matched.'
                      : matches.join('\n') +
                        (matches.length >= cap
                          ? `\n…truncated at ${cap} matches — narrow pattern or path`
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
                  text: `Glob failed: ${error instanceof Error ? error.message : String(error)}`,
                },
              ],
            }
          }
        },
      ),
  )
}
