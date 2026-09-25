import { chmodSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(root, 'dist', 'cli.js')
const index = join(root, 'dist', 'index.js')
for (const path of [cli, index]) {
  if (existsSync(path)) chmodSync(path, 0o755)
}
