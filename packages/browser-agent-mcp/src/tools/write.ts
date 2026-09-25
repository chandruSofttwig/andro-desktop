import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod/v4'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { trackToolCall } from '../activity-bus.js'
import { resolveInWorkspace, toWorkspaceRelative } from '../paths.js'

export function registerWriteTool(server: McpServer): void {
  server.registerTool(
    'Write',
    {
      description:
        'Create or overwrite a file under the allowlisted workspace. Creates parent directories as needed.',
      annotations: {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: true,
        idempotentHint: true,
      },
      inputSchema: {
        path: z.string().describe('File path relative to workspace root'),
        content: z.string().describe('Full file contents to write'),
      },
    },
    async ({ path, content }) =>
      (() => {
        const activityArgs: Record<string, unknown> = { path, contentLength: content.length }
        return trackToolCall(
          'Write',
          {
            argsSummary: `${path} (${content.length} bytes)`,
            paths: [path],
            args: activityArgs,
          },
        async () => {
          try {
            // createParents lets a new nested path resolve: containment is
            // validated while building the chain, so this cannot escape.
            const abs = resolveInWorkspace(path, { mustExist: false, createParents: true })
            const existed = existsSync(abs)
            const before = existed ? await readFile(abs, 'utf8') : ''
            const beforeLines = before ? before.split(/\r?\n/) : []
            const afterLines = content.split(/\r?\n/)
            const common = Math.min(beforeLines.length, afterLines.length)
            let additions = Math.max(0, afterLines.length - beforeLines.length)
            let deletions = Math.max(0, beforeLines.length - afterLines.length)
            for (let i = 0; i < common; i++) {
              if (beforeLines[i] !== afterLines[i]) { additions++; deletions++ }
            }
            activityArgs.additions = additions
            activityArgs.deletions = deletions
            activityArgs.changeType = existed ? 'M' : 'A'
            await mkdir(dirname(abs), { recursive: true })
            await writeFile(abs, content, 'utf8')
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Wrote ${content.length} bytes to ${toWorkspaceRelative(abs)}`,
                },
              ],
            }
          } catch (error) {
            return {
              isError: true,
              content: [
                {
                  type: 'text' as const,
                  text: `Write failed: ${error instanceof Error ? error.message : String(error)}`,
                },
              ],
            }
          }
        },
      )
      })()
    )
}
