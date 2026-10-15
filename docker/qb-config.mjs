// Put Flix's Web UI settings into qBittorrent's own config file.
//
//   node qb-config.mjs <path to qBittorrent.conf> [port]
//
// qBittorrent keeps the Web UI keys under [Preferences]. The ones it wrote
// itself (including the built-in credentials it generates on first start) are
// removed first, so the file has exactly one of each when we are done.
import { readFileSync, writeFileSync } from 'node:fs'

const [confPath, portArg] = process.argv.slice(2)
if (!confPath) {
  console.error('usage: qb-config.mjs <qBittorrent.conf> [port]')
  process.exit(2)
}
const port = Number(portArg ?? 8080)

// Keys qBittorrent may have written for the Web UI, including a generated
// password we cannot use.
const drop = /^WebUI\\(Address|Port|LocalHostAuth|HostHeaderValidation|CSRFProtection|Username|Password_PBKDF2|AlternativeUIEnabled|RootFolder|UseHTTPS|HTTPS\\)/

const wanted = [
  // Bound to the container's own localhost and never published; Flix talks to
  // it from 127.0.0.1 in the same container. Requests from localhost are not
  // asked for credentials, so there is no password to get wrong -- the built-in
  // one this replaces could not be known to the app.
  'WebUI\\Address=127.0.0.1',
  `WebUI\\Port=${port}`,
  'WebUI\\LocalHostAuth=false',
  'WebUI\\HostHeaderValidation=false',
  'WebUI\\CSRFProtection=true',
]

const lines = readFileSync(confPath, 'utf8').split(/\r?\n/)
const section = '[Preferences]'
const out = []
let inPrefs = false
let prefsAt = -1
let prefsEnd = -1

for (const line of lines) {
  const trimmed = line.trim()
  if (trimmed.startsWith('[')) {
    if (inPrefs) prefsEnd = out.length
    inPrefs = trimmed === section
    if (inPrefs) prefsAt = out.length
    out.push(line)
    continue
  }
  if (inPrefs && drop.test(trimmed)) continue
  out.push(line)
}

if (prefsAt === -1) {
  while (out.length && out[out.length - 1].trim() === '') out.pop()
  if (out.length) out.push('')
  out.push(section, ...wanted, '')
} else {
  const at = prefsEnd === -1 ? out.length : prefsEnd
  out.splice(at, 0, ...wanted)
}

writeFileSync(confPath, out.join('\n').replace(/\n*$/, '\n'))
console.log(`qb-config: ${confPath} -> WebUI on 127.0.0.1:${port}, no localhost auth`)
