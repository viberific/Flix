import { test } from 'node:test'
import assert from 'node:assert/strict'

// Disk-pressure deletion (PRUNE_FREE_PCT). Everything here is the pure policy: a volume whose free space the test
// controls, a stub removal, and candidates that already passed every gate in whyKept(). The wiring into sweep() is
// covered by the retention e2e tests and by the sweep rows below.
process.env.DB_PATH = ':memory:'
const { pruneUnderPressure, PRUNE_BUSY_SEC } = await import('../src/retention.ts')
const { config } = await import('../src/config.ts')

const GB = 1e9

/** A volume of `totalGb`, starting `freeGb` free, that gives space back as downloads are removed. */
function volume(freeGb: number, totalGb: number, giveBack = true) {
  let free = freeGb * GB
  return {
    read: () => ({ free, total: totalGb * GB }),
    release: (bytes: number) => { if (giveBack) free += bytes },
    get freeGb() { return free / GB },
  }
}

interface Cand { torrentId: number; hash: string; addedAt: number; bytes: number; deletable?: boolean }
const cand = (torrentId: number, addedAt: number, bytesGb: number, deletable = true): Cand =>
  ({ torrentId, hash: `hash${torrentId}`, addedAt, bytes: bytesGb * GB, deletable })

/** Runs one pass against a volume, recording what it asked to remove. */
async function pass(cands: Cand[], v: ReturnType<typeof volume>, busy: number[] = []) {
  const asked: string[] = []
  const removed = await pruneUnderPressure(cands.map((c) => ({ ...c, deletable: c.deletable ?? true })), {
    free: () => v.read(),
    busy: (id) => busy.includes(id),
    remove: async (c) => { asked.push(c.hash); v.release(c.bytes) },
  })
  return { removed, asked }
}

async function withPrune(free: number, target: number, fn: () => Promise<void>) {
  const was = { free: config.pruneFreePct, target: config.pruneTargetPct }
  config.pruneFreePct = free; config.pruneTargetPct = target
  try { await fn() } finally { config.pruneFreePct = was.free; config.pruneTargetPct = was.target }
}

test('prune defaults: off, and back up to 10% when on', async () => {
  assert.equal(config.pruneFreePct, 0, 'a fresh install must keep deleting on release, exactly as before')
  assert.equal(config.pruneTargetPct, 10)
  assert.equal(PRUNE_BUSY_SEC, 1800, 'a download touched in the last 30 minutes may be playing')
})

test('prune: above the trigger nothing is deleted', async () => {
  await withPrune(5, 10, async () => {
    const v = volume(50, 100)
    const { removed, asked } = await pass([cand(1, 100, 2), cand(2, 200, 3)], v)
    assert.deepEqual(removed, [])
    assert.deepEqual(asked, [], 'not even asked the engine to remove anything')
  })
})

test('prune: below the trigger, oldest first, and it stops once back at the target', async () => {
  await withPrune(5, 10, async () => {
    // 2 GB free of 100: below the 5% trigger. Two GB per download, so it takes four deletions to reach 10 GB (10%).
    const v = volume(2, 100)
    // Handed in newest first on purpose: the order it deletes in must come from added_at, not from the row order.
    const cands = [cand(6, 600, 2), cand(5, 500, 2), cand(4, 400, 2), cand(3, 300, 2), cand(2, 200, 2), cand(1, 100, 2)]
    const { removed } = await pass(cands, v)
    assert.deepEqual(removed, ['hash1', 'hash2', 'hash3', 'hash4'], 'four oldest, in age order')
    assert.equal(v.freeGb, 10, 'and it stopped at the target rather than emptying the list')
  })
})

test('prune: a download somebody touched in the last 30 minutes is skipped', async () => {
  await withPrune(5, 10, async () => {
    const v = volume(2, 100)
    const { removed } = await pass([cand(1, 100, 2), cand(2, 200, 2), cand(3, 300, 2)], v, [1])
    assert.equal(removed.includes('hash1'), false, 'the one being watched is not deleted mid-playback')
    assert.deepEqual(removed, ['hash2', 'hash3'], 'the next oldest go instead, until the target is met')
  })
})

test('prune: a download whose seeding goal is unmet is never deleted, however tight the disk', async () => {
  await withPrune(5, 50, async () => {
    const v = volume(1, 100)
    // The oldest of them all, and the biggest: it would go first if age and size were the only rule.
    const { removed } = await pass([cand(1, 100, 40, false), cand(2, 200, 1), cand(3, 300, 1)], v)
    assert.equal(removed.includes('hash1'), false, 'refusing costs disk; a wrong delete can cost the BTN account')
    assert.deepEqual(removed, ['hash2', 'hash3'], 'the ones that can go still go')
  })
})

test('prune: free space unreadable deletes nothing at all', async () => {
  await withPrune(5, 10, async () => {
    const asked: string[] = []
    const removed = await pruneUnderPressure([cand(1, 100, 2), cand(2, 200, 2)].map((c) => ({ ...c, deletable: true })), {
      free: () => null,
      busy: () => false,
      remove: async (c) => { asked.push(c.hash) },
    })
    assert.deepEqual(removed, [])
    assert.deepEqual(asked, [], 'fail closed: nothing is removed on a guess')
  })
})

test('prune: with PRUNE_FREE_PCT=0 the pass does nothing, because sweep is deleting on release as before', async () => {
  await withPrune(0, 10, async () => {
    const v = volume(1, 100)
    const { removed, asked } = await pass([cand(1, 100, 2), cand(2, 200, 2)], v)
    assert.deepEqual(removed, [])
    assert.deepEqual(asked, [])
  })
})

test('prune: it stops when the volume has not yet given the space back', async () => {
  await withPrune(5, 10, async () => {
    // qBittorrent can return before the files are unlinked. Free space stays put, so the pass must not go on and
    // delete every candidate on a reading that has not caught up.
    const v = { read: () => ({ free: 2 * GB, total: 100 * GB }), release: () => {}, freeGb: 2 }
    const { removed } = await pass([cand(1, 100, 2), cand(2, 200, 2), cand(3, 300, 2)], v)
    assert.deepEqual(removed, ['hash1'], 'one deletion, then it waits for the next sweep')
  })
})
