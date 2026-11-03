const test = require('node:test')
const { beforeEach, after } = test
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')
const { createCoverRenderer } = require('../lib/cover-video-renderer')

const ffmpegPath = process.env.TEST_FFMPEG_PATH
assert.ok(ffmpegPath && fs.existsSync(ffmpegPath))
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cover-render-test-'))
const sourceRoot = path.join(directory, 'sources')
const exportRoot = path.join(directory, 'exports')
fs.mkdirSync(sourceRoot)
fs.mkdirSync(exportRoot)
after(() => fs.rmSync(directory, { recursive: true, force: true }))

const source = path.join(sourceRoot, 'synthetic.wav')
const cover = path.join(exportRoot, 'synthetic.png')
const wav = Buffer.alloc(44 + 48000 * 2)
wav.write('RIFF', 0)
wav.writeUInt32LE(wav.length - 8, 4)
wav.write('WAVEfmt ', 8)
wav.writeUInt32LE(16, 16)
wav.writeUInt16LE(1, 20)
wav.writeUInt16LE(1, 22)
wav.writeUInt32LE(48000, 24)
wav.writeUInt32LE(96000, 28)
wav.writeUInt16LE(2, 32)
wav.writeUInt16LE(16, 34)
wav.write('data', 36)
wav.writeUInt32LE(wav.length - 44, 40)
fs.writeFileSync(source, wav)

const childEnv = {
  PATH: process.env.PATH || '/usr/bin:/bin',
  LANG: 'C',
  TMPDIR: directory,
}
execFileSync(ffmpegPath, [
  '-hide_banner', '-loglevel', 'error', '-nostdin',
  '-f', 'lavfi', '-i', 'color=c=0x00e5d1:s=320x180',
  '-frames:v', '1', '-threads', '1', cover,
], { timeout: 10000, env: childEnv, stdio: 'pipe' })

const digest = file => crypto.createHash('sha256')
  .update(fs.readFileSync(file)).digest('hex')
const sourceDigest = digest(source)
const coverDigest = digest(cover)

beforeEach(() => {
  for (const name of fs.readdirSync(exportRoot)) {
    if (name !== 'synthetic.png') {
      fs.rmSync(path.join(exportRoot, name), { recursive: true, force: true })
    }
  }
})

function renderer(options = {}) {
  return createCoverRenderer({
    ffmpegPath, sourceRoot, exportRoot,
    timeoutMs: 15000, ...options,
  })
}

for (const [preset, width, height] of [
  ['landscape720', 1280, 720],
  ['landscape1080', 1920, 1080],
]) {
  test(preset + ': real FFmpeg renders and decodes the synthetic cover/audio MP4', async () => {
    const r = renderer()
    const result = await r.render({
      sourcePath: source, coverPath: cover, id: preset, preset,
    })
    assert.equal(result.width, width)
    assert.equal(result.height, height)
    assert.equal(result.videoCodec, 'h264')
    assert.equal(result.audioCodec, 'aac')
    assert.ok(Math.abs(result.duration - 1) <= 0.3)
    assert.ok(result.sizeBytes > 64)
    assert.equal(digest(source), sourceDigest)
    assert.equal(digest(cover), coverDigest)
    assert.equal(r.isBusy(), false)
    assert.equal(fs.readdirSync(exportRoot).some(n => n.startsWith('.render-')), false)

    const bytes = fs.readFileSync(result.path)
    const boxes = []
    for (let offset = 0; offset + 8 <= bytes.length;) {
      const size = bytes.readUInt32BE(offset)
      assert.ok(size >= 8)
      boxes.push(bytes.toString('ascii', offset + 4, offset + 8))
      offset += size
    }
    assert.ok(boxes.includes('ftyp'))
    assert.ok(boxes.indexOf('moov') >= 0)
    assert.ok(boxes.indexOf('moov') < boxes.indexOf('mdat'))

    execFileSync(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error', '-nostdin',
      '-threads', '1', '-protocol_whitelist', 'file',
      '-i', result.path,
      '-map', '0:v:0', '-map', '0:a:0',
      '-threads', '1', '-f', 'null', '-',
    ], { timeout: 10000, env: childEnv, stdio: 'pipe' })
  })
}

test('invalid cover is rejected without publishing or changing the source', async () => {
  const bad = path.join(exportRoot, 'bad.png')
  fs.writeFileSync(bad, 'not an image')
  await assert.rejects(renderer().render({
    sourcePath: source, coverPath: bad, id: 'bad_cover',
  }), /bounded PNG or JPEG/)
  assert.equal(fs.existsSync(path.join(exportRoot, 'bad_cover.mp4')), false)
  assert.equal(digest(source), sourceDigest)
})

test('existing output is never replaced', async () => {
  const output = path.join(exportRoot, 'existing.mp4')
  fs.writeFileSync(output, 'keep existing output')
  await assert.rejects(renderer().render({
    sourcePath: source, coverPath: cover, id: 'existing',
  }), /already exists/)
  assert.equal(fs.readFileSync(output, 'utf8'), 'keep existing output')
})

test('source outside the assigned archive is rejected', async () => {
  const outside = path.join(directory, 'outside.wav')
  fs.writeFileSync(outside, wav)
  await assert.rejects(renderer().render({
    sourcePath: outside, coverPath: cover, id: 'outside',
  }), /outside its assigned directory/)
})

test('symlink source is rejected', async () => {
  const link = path.join(sourceRoot, 'linked.wav')
  fs.symlinkSync(source, link)
  try {
    await assert.rejects(renderer().render({
      sourcePath: link, coverPath: cover, id: 'symlink',
    }), /outside its assigned directory/)
  } finally {
    fs.unlinkSync(link)
  }
})

test('unknown preset is rejected before FFmpeg starts', async () => {
  let calls = 0
  await assert.rejects(renderer({
    execFile() { calls++ },
  }).render({
    sourcePath: source, coverPath: cover, id: 'preset', preset: 'unknown',
  }), /Invalid export ID or preset/)
  assert.equal(calls, 0)
})

test('overlapping rendering is refused and failure releases the busy state', async () => {
  let finish
  const r = renderer({
    execFile(file, args, options, callback) { finish = callback },
  })
  const first = r.render({
    sourcePath: source, coverPath: cover, id: 'first',
  })
  assert.equal(r.isBusy(), true)
  await assert.rejects(r.render({
    sourcePath: source, coverPath: cover, id: 'second',
  }), /busy/)
  finish(Object.assign(new Error('private details'), { code: 2 }), '', '')
  await assert.rejects(first, /FFmpeg could not complete/)
  assert.equal(r.isBusy(), false)
})

test('failed rendering removes partial files and does not disclose process details', async () => {
  const r = renderer({
    execFile(file, args, options, callback) {
      if (args.includes('-c:v')) {
        fs.writeFileSync(args.at(-1), 'partial output')
        callback(Object.assign(new Error('private credentials'), { code: 2 }), '',
          'private credentials in stderr')
      } else {
        callback(Object.assign(new Error('probe'), { code: 1 }), '',
          'Duration: 00:00:01.00\nAudio: pcm_s16le')
      }
    },
  })
  await assert.rejects(r.render({
    sourcePath: source, coverPath: cover, id: 'failed',
  }), error => {
    assert.match(error.message, /FFmpeg could not complete/)
    assert.doesNotMatch(error.message, /credentials/)
    return true
  })
  assert.equal(fs.existsSync(path.join(exportRoot, 'failed.mp4')), false)
  assert.equal(fs.readdirSync(exportRoot).some(n => n.startsWith('.render-')), false)
  assert.equal(digest(source), sourceDigest)
})

