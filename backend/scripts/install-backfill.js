'use strict'
const fs = require('fs')
const path = require('path')
const target = path.join(__dirname, '..', 'routes', 'space.js')
const source = fs.readFileSync(target, 'utf8')
const marker = '// Historical-playlist backfill v1'
if (source.includes(marker)) { console.log('Backfill already installed'); process.exit(0) }
const anchor = '    let media = await getMediaPlaylist(m3u8, hdr)'
if (source.split(anchor).length !== 2) throw new Error('Unexpected source: expected one initial playlist fetch; no changes made')
const replacement = `    let media = await getMediaPlaylist(m3u8, hdr)
    // Historical-playlist backfill v1
    // Preserve the live URL and ENDLIST state; only prepend historical segments.
    if (!media.hasEndList && /\\/dynamic_playlist\\.m3u8$/.test(new URL(m3u8).pathname)) {
      try {
        const master = new URL(m3u8)
        master.pathname = master.pathname.replace(/dynamic_playlist\\.m3u8$/, 'master_playlist.m3u8')
        master.searchParams.delete('type')
        const masterText = await fetchText(master.href, hdr)
        if (!masterText.includes('#EXTM3U')) throw new Error('Master is not HLS')
        const candidates = masterText.split(/\\r?\\n/).map(s => s.trim()).filter(s => s && !s.startsWith('#'))
        let historical = null
        for (const candidate of candidates.slice(0, 6)) {
          const url = new URL(candidate, master.href)
          if (url.origin !== master.origin) continue
          if (/dynamic_playlist\\.m3u8$/.test(url.pathname)) continue
          url.searchParams.set('type', 'replay')
          try {
            const item = await getMediaPlaylist(url.href, hdr)
            if (item.segments.length && (!historical || item.durations.reduce((a,b) => a+b,0) > historical.durations.reduce((a,b) => a+b,0))) historical = item
          } catch (error) { log('backfill candidate unavailable', error.message) }
        }
        if (historical) {
          if ((historical.initUri || null) !== (media.initUri || null)) throw new Error('Different initialization maps; refusing unsafe concatenation')
          if (!historical.segments.some(url => media.segments.includes(url))) throw new Error('No overlapping segments; refusing unverified ordering')
          const seenBackfill = new Set()
          const segments = [], durations = []
          for (const playlist of [historical, media]) {
            playlist.segments.forEach((url, i) => {
              if (!seenBackfill.has(url)) { seenBackfill.add(url); segments.push(url); durations.push(playlist.durations[i]) }
            })
          }
          log('backfill: initial segment count', media.segments.length, '->', segments.length, '; beginning coverage NOT guaranteed')
          media = { ...media, segments, durations }
        } else { log('backfill: no historical playlist available; keeping live capture') }
      } catch (error) { log('backfill unavailable; keeping live capture:', error.message) }
    }`
const updated = source.replace(anchor, replacement)
const backup = target + '.before-backfill-' + Date.now()
fs.writeFileSync(backup, source, { flag: 'wx' })
fs.writeFileSync(target + '.backfill-tmp', updated)
fs.renameSync(target + '.backfill-tmp', target)
console.log('Patched:', target, 'Backup:', backup)
console.log('Run node --check on the patched file and test before deployment. Existing jobs are unchanged.')
