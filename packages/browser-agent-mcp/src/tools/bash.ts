import { spawn } from 'node:child_process'
import { z } from 'zod/v4'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { trackToolCall } from '../activity-bus.js'
import { config } from '../config.js'
import { STDERR_CAP, STDOUT_CAP, truncateOutput } from '../limits.js'
import { assertCwdInWorkspace, getWorkspaceRoot, toWorkspaceRelative } from '../paths.js'
import {
  buildSandboxedCommand,
  SandboxUnavailableError,
  sandboxStatus,
} from '../sandbox.js'

function shellCommand(command: string): { exe: string; args: string[] } {
  if (process.platform === 'win32') {
    return { exe: 'cmd.exe', args: ['/d', '/s', '/c', command] }
  }
  return { exe: '/bin/bash', args: ['-lc', command] }
}

export function registerBashTool(server: McpServer): void {
  server.registerTool(
    'Bash',
    {
      description:
        'Run a shell command confined to the workspace. The command cannot read or write outside it. Prefer Glob/Grep/Read/Edit for file work — Bash is slower and heavier. Output and timeout are capped.',
      annotations: {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: true,
      },
      inputSchema: {
        command: z.string().describe('Shell command to run'),
        cwd: z
          .string()
          .optional()
          .describe('Working directory relative to workspace (default: workspace root)'),
        timeout_ms: z
          .number()
          .int()
          .min(1000)
          .max(120_000)
          .optional()
          .describe('Timeout in ms (default from BASH_TIMEOUT_MS, typically 30s)'),
      },
    },
    async ({ command, cwd, timeout_ms }) =>
      trackToolCall(
        'Bash',
        {
          argsSummary: command.length > 80 ? `${command.slice(0, 80)}…` : command,
          paths: cwd ? [cwd] : [],
          args: { command, cwd, timeout_ms },
        },
        async (emitProgress) => {
          try {
            const workdir = assertCwdInWorkspace(cwd)
            const timeout = Math.min(timeout_ms ?? config.bashTimeoutMs, 120_000)

            // Confine the command itself, not just its working directory. cwd
            // validation alone is not a jail — `cat /etc/passwd` ignores cwd.
            const status = sandboxStatus()
            let exe: string
            let args: string[]
            let extraEnv: Record<string, string> = {}
            if (status.active) {
              const sandboxed = buildSandboxedCommand(command, getWorkspaceRoot())
              exe = sandboxed.exe
              args = sandboxed.args
              extraEnv = sandboxed.env
            } else {
              const unsandboxed = shellCommand(command)
              exe = unsandboxed.exe
              args = unsandboxed.args
            }

            const result = await new Promise<{
              code: number | null
              stdout: string
              stderr: string
              timedOut: boolean
            }>((resolve) => {
              const child = spawn(exe, args, {
                cwd: workdir,
                env: {
                  PATH: process.env.PATH,
                  HOME: process.env.HOME,
                  USERPROFILE: process.env.USERPROFILE,
                  USER: process.env.USER,
                  LANG: process.env.LANG ?? 'C.UTF-8',
                  TERM: 'dumb',
                  BROWSER_AGENT_MCP_WORKSPACE: getWorkspaceRoot(),
                  ...extraEnv,
                },
                stdio: ['ignore', 'pipe', 'pipe'],
                windowsHide: true,
              })
              let stdout = ''
              let stderr = ''
              let timedOut = false
              const timer = setTimeout(() => {
                timedOut = true
                child.kill('SIGKILL')
              }, timeout)
              child.stdout.on('data', (chunk: Buffer) => {
                const text = chunk.toString('utf8')
                if (stdout.length < STDOUT_CAP) stdout += text.slice(0, Math.max(0, STDOUT_CAP - stdout.length))
                emitProgress({ output: text, outputType: 'stdout' })
              })
              child.stderr.on('data', (chunk: Buffer) => {
                const text = chunk.toString('utf8')
                if (stderr.length < STDERR_CAP) stderr += text.slice(0, Math.max(0, STDERR_CAP - stderr.length))
                emitProgress({ output: text, outputType: 'stderr' })
              })
              child.on('close', (code) => {
                clearTimeout(timer)
                resolve({ code, stdout, stderr, timedOut })
              })
              child.on('error', (err) => {
                clearTimeout(timer)
                resolve({ code: 1, stdout, stderr: err.message, timedOut })
              })
            })

            const parts = [
              `cwd: ${toWorkspaceRelative(workdir)}`,
              `exit: ${result.timedOut ? 'timeout' : result.code}`,
              `sandbox: ${status.active ? 'bwrap (workspace-confined)' : `OFF (${status.reason})`}`,
            ]
            if (result.stdout) {
              parts.push(`stdout:\n${truncateOutput(result.stdout, STDOUT_CAP, 'stdout')}`)
            }
            if (result.stderr) {
              parts.push(`stderr:\n${truncateOutput(result.stderr, STDERR_CAP, 'stderr')}`)
            }
            if (result.timedOut) {
              parts.push(`Command killed after ${timeout}ms`)
            }

            return {
              isError: Boolean(result.timedOut || (result.code !== 0 && result.code !== null)),
              content: [{ type: 'text' as const, text: parts.join('\n\n') }],
            }
          } catch (error) {
            const message =
              error instanceof SandboxUnavailableError
                ? error.message
                : `Bash failed: ${error instanceof Error ? error.message : String(error)}`
            return {
              isError: true,
              content: [{ type: 'text' as const, text: message }],
            }
          }
        },
      ),
  )
}
