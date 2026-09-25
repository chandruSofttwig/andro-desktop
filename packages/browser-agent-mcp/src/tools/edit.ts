import { readFile, writeFile } from 'node:fs/promises'
import { z } from 'zod/v4'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { trackToolCall } from '../activity-bus.js'
import { resolveInWorkspace, toWorkspaceRelative } from '../paths.js'

export function registerEditTool(server: McpServer): void {
  server.registerTool(
    'Edit',
    {
      description:
        'Exact string replacement in a file under the workspace. Prefer Edit over Bash for code changes.',
      annotations: {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: true,
        idempotentHint: false,
      },
      inputSchema: {
        path: z.string().describe('File path relative to workspace root'),
        old_string: z.string().describe('Exact text to find'),
        new_string: z.string().describe('Replacement text'),
        replace_all: z
          .boolean()
          .optional()
          .describe('Replace every occurrence (default false)'),
      },
    },
    async ({ path, old_string, new_string, replace_all }) =>
      (() => {
        const activityArgs: Record<string, unknown> = {
          path,
          old_string_len: old_string.length,
          new_string_len: new_string.length,
          replace_all: Boolean(replace_all),
        }
        return trackToolCall(
          'Edit',
          {
            argsSummary: path,
            paths: [path],
            args: activityArgs,
          },
        async () => {
          try {
            if (old_string === new_string) {
              throw new Error('old_string and new_string are identical')
            }
            const abs = resolveInWorkspace(path, { mustExist: true })
            const before = await readFile(abs, 'utf8')
            const count = before.split(old_string).length - 1
            if (count === 0) {
              throw new Error('old_string not found in file')
            }
            if (!replace_all && count > 1) {
              throw new Error(
                `old_string found ${count} times; set replace_all=true or provide a more specific string`,
              )
            }
            const after = replace_all
              ? before.split(old_string).join(new_string)
              : before.replace(old_string, new_string)
            const beforeLines = before.split(/\r?\n/)
            const afterLines = after.split(/\r?\n/)
            const common = Math.min(beforeLines.length, afterLines.length)
            let additions = Math.max(0, afterLines.length - beforeLines.length)
            let deletions = Math.max(0, beforeLines.length - afterLines.length)
            for (let i = 0; i < common; i++) {
              if (beforeLines[i] !== afterLines[i]) {
                additions++
                deletions++
              }
            }
            activityArgs.additions = additions
            activityArgs.deletions = deletions
            activityArgs.changeType = 'M'
            await writeFile(abs, after, 'utf8')
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Edited ${toWorkspaceRelative(abs)} (${replace_all ? count : 1} replacement(s))`,
                },
              ],
            }
          } catch (error) {
            return {
              isError: true,
              content: [
                {
                  type: 'text' as const,
                  text: `Edit failed: ${error instanceof Error ? error.message : String(error)}`,
                },
              ],
            }
          }
        },
      )
      })()
    )
}
