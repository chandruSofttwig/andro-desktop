import { cpSync, existsSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = join(root, 'ui', 'dist')
const dest = join(root, 'dist', 'ui')

if (!existsSync(src)) {
  console.error(`UI build missing at ${src} — run build:ui first`)
  process.exit(1)
}

rmSync(dest, { recursive: true, force: true })
cpSync(src, dest, { recursive: true })
console.log(`Copied UI → ${dest}`)
