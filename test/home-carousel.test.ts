import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8')

test('home carousel rows leave room after the last card without shifting start alignment or snapping', () => {
  const rail = css.match(/\.row-scroll\s*\{([^}]+)\}/)?.[1]
  assert.ok(rail, 'the shared home carousel rail rule exists')
  const padding = rail.match(/(?:^|;)\s*padding:\s*([^;]+)/)?.[1].trim().split(/\s+/)
  assert.deepEqual(padding, ['8px', '24px', '22px', '4px'], 'add end padding while preserving the original start inset')
  assert.match(rail, /scroll-snap-type:\s*x proximity/, 'horizontal proximity snapping remains enabled')
  assert.match(css, /\.tile\s*\{[^}]*scroll-snap-align:\s*start/, 'cards still snap to their original start alignment')
})
