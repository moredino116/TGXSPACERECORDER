const fs = require('node:fs')
const path = require('node:path')
const { execFile: nativeExecFile } = require('node:child_process')

const PRESETS = Object.freeze({
  landscape720: { width: 1280, height: 720 },
  landscape1080: { width: 1920, height: 1080 },
})
let active = false

function createCoverRenderer({
  ffmpegPath, sourceRoot, exportRoot,
  execFile = nativeExecFile,
  timeoutMs = 1800000,
}) {
  if (!ffmpegPath || !path.isAbsolute(ffmpegPath)) {
    throw new Error('An absolute FFmpeg executable path is required')
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 1800000) {
    throw new Error('Invalid rendering timeout')
  }
  const sources = fs.realpathSync(sourceRoot)
  const exports = fs.realpathSync(exportRoot)

  function inside(root, file) {
    const relative = path.relative(root, file)
    return relative !== '' && relative !== '..' &&
      !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)
  }

  function inputFile(root, supplied, maxBytes) {
    try {
      if (typeof supplied !== 'string' || !path.isAbsolute(supplied)) {
        throw new Error()
      }
      const stat = fs.lstatSync(supplied)
      if (!stat.isFile() || stat.isSymbolicLink() ||
          stat.size < 1 || stat.size > maxBytes) throw new Error()
      const resolved = fs.realpathSync(supplied)
      if (!inside(root, resolved)) throw new Error()
      return resolved
    } catch {
      throw new Error('Input file is unavailable or outside its assigned directory')
    }
  }

  function checkCover(file) {
    const bytes = fs.readFileSync(file)
    let width, height
    if (bytes.length >= 24 &&
        bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) &&
        bytes.toString('ascii', 12, 16) === 'IHDR') {
      width = bytes.readUInt32BE(16)
      height = bytes.readUInt32BE(20)
    } else if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216) {
      let offset = 2
      const stop = Math.min(bytes.length, 65536)
      while (offset + 3 < stop) {
        if (bytes[offset++] !== 255) break
        while (offset < stop && bytes[offset] === 255) offset++
        const marker = bytes[offset++]
        if (marker === 217 || marker === 218) break
        if (marker === 1 || marker >= 208 && marker <= 215) continue
        if (offset + 2 > stop) break
        const length = bytes.readUInt16BE(offset)
        if (length < 2 || offset + length > stop) break
        if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)) {
          if (length < 8) break
          height = bytes.readUInt16BE(offset + 3)
          width = bytes.readUInt16BE(offset + 5)
          break
        }
        offset += length
      }
    }
    if (!width || !height || width > 4096 || height > 4096 ||
        width * height > 16000000) {
      throw new Error('Cover must be a bounded PNG or JPEG image')
    }
  }

  function invoke(args, probing = false) {
    return new Promise((resolve, reject) => {
      const options = {
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer: 1024 * 1024,
        shell: false,
        windowsHide: true,
        env: {
          PATH: process.env.PATH || '/usr/bin:/bin',
          LANG: 'C',
          TMPDIR: exports,
        },
      }
      try {
        execFile(ffmpegPath, args, options, (error, stdout, stderr) => {
          if (error && (!probing || error.killed || error.code !== 1)) {
            reject(new Error('FFmpeg could not complete the export'))
          } else {
            resolve(String(stderr || ''))
          }
        })
      } catch {
        reject(new Error('FFmpeg could not complete the export'))
      }
    })
  }

  async function probe(file) {
    const text = await invoke([
      '-hide_banner', '-nostdin',
      '-protocol_whitelist', 'file',
      '-format_whitelist', 'mov,mp3,aac,wav,ogg,flac,matroska,webm,mpegts',
      '-i', file,
    ], true)
    const match = text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/)
    if (!match || !/Audio:/.test(text)) {
      throw new Error('Audio duration could not be verified')
    }
    const duration = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])
    if (!Number.isFinite(duration) || duration < 0.1 || duration > 43200) {
      throw new Error('Audio duration is outside the renderer bounds')
    }
    return { duration, text }
  }

  async function render({
    sourcePath, coverPath, id, preset = 'landscape720',
  }) {
    if (active) throw new Error('Export renderer is busy')
    active = true
    let scratch
    try {
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(id || '') ||
          !Object.hasOwn(PRESETS, preset)) {
        throw new Error('Invalid export ID or preset')
      }
      const source = inputFile(sources, sourcePath, 2 * 1024 * 1024 * 1024)
      const cover = inputFile(exports, coverPath, 2 * 1024 * 1024)
      checkCover(cover)
      const output = path.join(exports, id + '.mp4')
      if (fs.existsSync(output)) throw new Error('Export output already exists')

      scratch = fs.mkdtempSync(path.join(exports, `.render-${id}-`))
      const temporary = path.join(scratch, 'output.mp4')
      const input = await probe(source)
      const { width, height } = PRESETS[preset]

      await invoke([
        '-hide_banner', '-loglevel', 'error', '-nostdin', '-n',
        '-filter_threads', '1', '-filter_complex_threads', '1',
        '-protocol_whitelist', 'file',
        '-loop', '1', '-framerate', '2', '-threads', '1', '-i', cover,
        '-protocol_whitelist', 'file',
        '-format_whitelist', 'mov,mp3,aac,wav,ogg,flac,matroska,webm,mpegts',
        '-threads', '1', '-i', source,
        '-map', '0:v:0', '-map', '1:a:0',
        '-map_metadata', '-1', '-map_chapters', '-1',
        '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
          `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`,
        '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'stillimage',
        '-threads:v', '1', '-pix_fmt', 'yuv420p', '-r', '24',
        '-c:a', 'aac', '-threads:a', '1', '-b:a', '128k', '-ar', '48000', '-ac', '2',
        '-t', String(input.duration), '-shortest',
        '-fs', String(512 * 1024 * 1024),
        '-movflags', '+faststart', '-f', 'mp4', temporary,
      ])

      const stat = fs.statSync(temporary)
      if (!stat.isFile() || stat.size < 64 || stat.size > 512 * 1024 * 1024) {
        throw new Error('Export output size could not be verified')
      }
      const outputInfo = await probe(temporary)
      if (Math.abs(outputInfo.duration - input.duration) > 0.3 ||
          !/Video:\s*h264\b/.test(outputInfo.text) ||
          !/Audio:\s*aac\b/.test(outputInfo.text) ||
          !/\byuv420p\b/.test(outputInfo.text) ||
          !new RegExp('\\b' + width + 'x' + height + '\\b').test(outputInfo.text)) {
        throw new Error('Export media validation failed')
      }

      // Atomic publication that refuses to replace an existing destination.
      fs.linkSync(temporary, output)
      return {
        path: output, sizeBytes: stat.size,
        width, height, duration: outputInfo.duration,
        videoCodec: 'h264', audioCodec: 'aac',
      }
    } catch (error) {
      const safe = [
        'Input file is unavailable or outside its assigned directory',
        'Cover must be a bounded PNG or JPEG image',
        'Invalid export ID or preset',
        'Export output already exists',
        'FFmpeg could not complete the export',
        'Audio duration could not be verified',
        'Audio duration is outside the renderer bounds',
        'Export output size could not be verified',
        'Export media validation failed',
      ]
      throw new Error(safe.includes(error.message)
        ? error.message : 'Export could not be completed')
    } finally {
      try {
        if (scratch) fs.rmSync(scratch, { recursive: true, force: true })
      } finally {
        active = false
      }
    }
  }

  return { render, isBusy: () => active }
}

module.exports = { createCoverRenderer, PRESETS }
