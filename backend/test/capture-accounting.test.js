const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const source = fs.readFileSync(
  path.join(__dirname, '../routes/space.js'), 'utf8'
)
const begin = source.indexOf('async function runJob(job, m3u8) {')
const end = source.indexOf('\n}\n', begin) + 2
assert.ok(begin >= 0 && end > begin)
const functionSource = source.slice(begin, end)

function media({
  segments = ['a', 'b', 'c'],
  durations = [5, 8, 7],
  live = false,
  initUri,
} = {}) {
  return {
    url: 'https://media.example/mock.m3u8',
    segments, durations, hasEndList: !live, target: 2, initUri,
  }
}

async function run(options = {}) {
  let now = 0
  let playlistCalls = 0
  let processed = 0
  const files = new Map()
  const archives = []
  const logs = []

  const job = {
    id: 'mock_job', baseName: 'mock', state: 'downloading',
    done: 0, total: 0, gaps: 0, startedAt: 0,
    role: 'backup', enhance: false, cookie: null,
  }
  const fakeFs = {
    createWriteStream(file) {
      files.set(file, Buffer.alloc(0))
      return {
        write(buffer, callback) {
          if (options.writeFails) {
            callback(new Error('Simulated write failure'))
          } else {
            files.set(file, Buffer.concat([files.get(file), buffer]))
            callback()
          }
        },
        end(callback) { if (callback) callback() },
      }
    },
    existsSync: file => files.has(file),
    statSync: file => ({ size: files.get(file).length }),
    unlinkSync: file => files.delete(file),
  }

  const context = {
    Buffer, path, fs: fakeFs, DL_DIR: '/virtual',
    Date: class extends Date { static now() { return now } },
    console: { log: (...args) => logs.push(args.map(String).join(' ')) },
    sleep: async ms => { now += ms },
    getMediaPlaylist: async () => {
      playlistCalls++
      if (options.playlistError) throw options.playlistError
      return options.playlist
        ? options.playlist(playlistCalls)
        : media(options)
    },
    fetchBufRetry: async url => {
      if (options.fetch) return options.fetch(url)
      return Buffer.from(url)
    },
    pool: async (items, worker) => Promise.all(items.map(worker)),
    processLocal: async (input, output) => {
      processed++
      if (options.processingFails) throw new Error('Simulated processing failure')
      if (options.processingReturnsFalse) return false
      files.set(output, Buffer.from(files.get(input)))
      return true
    },
    archiveInsert: async row => archives.push({ ...row }),
    onJobTerminal() {},
    startHistoricalCompanion: async () => {},
    mapHistoricalSnapshot: value => value,
  }

  const capture = vm.runInNewContext('(' + functionSource + ')', context)
  await capture(job, 'https://media.example/mock.m3u8')
  return { job, files, archives, logs, now, processed }
}

test('successful segments count only after writing and preserve total duration', async () => {
  const q = await run()
  assert.equal(q.job.state, 'ready')
  assert.equal(q.job.capturedSegments, 3)
  assert.equal(q.job.capturedBytes, 3)
  assert.equal(q.job.recordedSecs, 20)
  assert.equal(q.job.gaps, 0)
})

test('failed segments do not increase captured duration or bytes', async () => {
  const q = await run({
    fetch: async url => {
      if (url === 'b') throw new Error('HTTP 503')
      return Buffer.from(url)
    },
  })
  assert.equal(q.job.state, 'ready')
  assert.equal(q.job.done, 3)
  assert.equal(q.job.capturedSegments, 2)
  assert.equal(q.job.capturedBytes, 2)
  assert.equal(q.job.recordedSecs, 12)
  assert.equal(q.job.gaps, 1)
  assert.equal(q.job.gapSeconds, 8)
})

test('all failed live segments cannot bypass the ninety-second no-audio guard', async () => {
  const q = await run({
    live: true,
    fetch: async () => { throw new Error('HTTP 503') },
  })
  assert.equal(q.job.state, 'error')
  assert.equal(q.job.capturedSegments, 0)
  assert.equal(q.job.recordedSecs, 0)
  assert.ok(q.now > 90000 && q.now <= 100000)
  assert.equal(q.processed, 0)
  assert.equal(q.archives.length, 0)
})

test('new failing segments cannot keep resetting the actual-audio inactivity timer', async () => {
  const q = await run({
    playlist: n => media({
      segments: n === 1 ? ['good'] : ['bad' + n],
      durations: [6], live: true,
    }),
    fetch: async url => {
      if (url === 'good') return Buffer.from('audio')
      throw new Error('HTTP 503')
    },
  })
  assert.equal(q.job.capturedSegments, 1)
  assert.equal(q.job.recordedSecs, 6)
  assert.ok(q.job.gaps > 0)
  assert.ok(q.now > 300000 && q.now <= 310000)
})

test('empty segment data is not accepted as audio', async () => {
  const q = await run({ fetch: async () => Buffer.alloc(0) })
  assert.equal(q.job.state, 'error')
  assert.equal(q.job.capturedSegments, 0)
  assert.equal(q.job.recordedSecs, 0)
  assert.equal(q.archives.length, 0)
})

test('failed writes cannot advance captured duration or successful segment count', async () => {
  const q = await run({ writeFails: true })
  assert.equal(q.job.state, 'error')
  assert.equal(q.job.capturedSegments, 0)
  assert.equal(q.job.recordedSecs, 0)
  assert.equal(q.archives.length, 0)
})

test('successfully written raw audio is retained if later processing throws', async () => {
  const q = await run({ processingFails: true })
  assert.equal(q.job.state, 'ready')
  assert.equal(q.job.file, '/virtual/mock_job.raw')
  assert.equal(q.job.capturedSegments, 3)
  assert.equal(q.archives.length, 1)
})

test('signed URLs are not copied into capture errors or logs', async () => {
  const secret = 'private-session-marker'
  const q = await run({
    playlistError: new Error(
      'HTTP 403 for https://media.example/audio?token=' + secret
    ),
  })
  assert.equal(q.job.state, 'error')
  assert.equal(q.job.error.includes(secret), false)
  assert.equal(q.logs.join('\n').includes(secret), false)
  assert.match(q.job.error, /HTTP 403/)
})

test('initialization headers alone are not retained as a ready audio recording', async () => {
  const q = await run({
    initUri: 'header',
    fetch: async url => {
      if (url === 'header') return Buffer.from('initialization-only')
      throw new Error('HTTP 503')
    },
  })
  assert.equal(q.job.state, 'error')
  assert.equal(q.job.capturedSegments, 0)
  assert.equal(q.archives.length, 0)
})


test('thrown processing failure marks retained audio with a warning', async () => {
  const q = await run({ processingFails: true })
  assert.equal(q.job.state, 'ready')
  assert.equal(q.job.captureWarning, 'processing_failed')
  assert.equal(q.job.file, '/virtual/mock_job.raw')
})

test('unsuccessful processing result marks the raw-audio fallback', async () => {
  const q = await run({ processingReturnsFalse: true })
  assert.equal(q.job.state, 'ready')
  assert.equal(q.job.captureWarning, 'processing_failed')
  assert.equal(q.job.file, '/virtual/mock_job.raw')
})


test('confirmed replay end is distinct from an inactivity ending', async () => {
  const q = await run()
  assert.equal(q.job.captureStopReason, 'playlist_end')
  assert.equal(q.job.captureWarning, null)
})

test('live inactivity records an unconfirmed end rather than a confirmed Space end', async () => {
  const q = await run({
    playlist: () => media({
      segments: ['good'], durations: [6], live: true,
    }),
  })
  assert.equal(q.job.captureStopReason, 'no_new_audio')
  assert.equal(q.job.captureWarning, 'capture_end_unconfirmed')
})

test('repeated playlist failure preserves captured audio with an explicit warning', async () => {
  const q = await run({
    playlist: n => {
      if (n === 1) return media({
        segments: ['good'], durations: [6], live: true,
      })
      throw new Error('HTTP 503')
    },
  })
  assert.equal(q.job.state, 'ready')
  assert.equal(q.job.captureStopReason, 'playlist_unavailable')
  assert.equal(q.job.captureWarning, 'capture_end_unconfirmed')
})

test('capture time limit is not reported as a confirmed playlist end', async () => {
  const q = await run({
    playlist: n => ({
      ...media({ segments: ['audio' + n], durations: [1], live: true }),
      target: 30000,
    }),
  })
  assert.equal(q.job.captureStopReason, 'time_limit')
  assert.equal(q.job.captureWarning, 'capture_end_unconfirmed')
})
