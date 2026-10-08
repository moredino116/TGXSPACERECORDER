const telegram = window.Telegram?.WebApp
telegram?.ready()
telegram?.expand()

const notice = document.querySelector('#notice')
const gate = document.querySelector('#gate')
const app = document.querySelector('#app')
const who = document.querySelector('#who')
const form = document.querySelector('#record-form')
const input = document.querySelector('#space-input')
const live = document.querySelector('#live')
const archive = document.querySelector('#archive')
const clips = document.querySelector('#clips')
const jobs = new Map()

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]))
}

function safeUrl(value) {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:') return ''
    return url.href
  } catch {
    return ''
  }
}

function showNotice(message) {
  notice.hidden = !message
  notice.textContent = message || ''
}

function parseClock(token) {
  const parts = String(token || '').trim().split(':')
  if (!parts.length || parts.length > 3 || parts.some((part) => !/^\d+$/.test(part))) return null
  const numbers = parts.map(Number)
  if (numbers.length === 1) return numbers[0]
  if (numbers.length === 2) return numbers[0] * 60 + numbers[1]
  return numbers[0] * 3600 + numbers[1] * 60 + numbers[2]
}

function formatClock(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  const mm = String(minutes).padStart(2, '0')
  const ss = String(secs).padStart(2, '0')
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${minutes}:${ss}`
}

function formatBytes(bytes) {
  const size = Number(bytes) || 0
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

async function relay(path, options = {}) {
  const response = await fetch(`/api/relay/${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `tma ${telegram?.initData || ''}`,
      ...(options.headers || {}),
    },
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`)
  return body
}

function audioHtml(url) {
  const safe = safeUrl(url)
  if (!safe) return ''
  return `<audio controls preload="none" src="${escapeHtml(safe)}"></audio>`
}

function renderLive() {
  if (!jobs.size) {
    live.innerHTML = ''
    return
  }
  live.innerHTML = [...jobs.values()].map((job) => `
    <article class="card item">
      <div class="row">
        <strong>${escapeHtml(job.title || job.name || 'Space')}</strong>
        <span class="meta">${escapeHtml(job.state || 'working')}</span>
      </div>
      <p class="meta">${escapeHtml(job.detail || '')}</p>
      ${audioHtml(job.previewUrl)}
      ${job.id && job.kind !== 'monitor' ? '<div class="actions"><button type="button" class="secondary" data-stop="' + escapeHtml(job.id) + '">Stop and save</button></div>' : ''}
    </article>
  `).join('')
}

function renderArchive(rows) {
  if (!rows.length) {
    archive.innerHTML = '<p class="empty">No saved recordings yet.</p>'
    return
  }
  archive.innerHTML = rows.map((row) => `
    <article class="item">
      <strong>${escapeHtml(row.title || row.name || row.id)}</strong>
      <p class="meta">${formatClock(row.duration_seconds)} · ${formatBytes(row.size_bytes)}${row.available === false ? ' · file missing' : ''}</p>
      ${audioHtml(row.previewUrl)}
      <form class="clip-form" data-clip="${escapeHtml(row.id)}">
        <input name="start" inputmode="numeric" placeholder="Start 1:30" required />
        <input name="end" inputmode="numeric" placeholder="End 4:00" required />
        <input name="title" placeholder="Clip title" />
        <button type="submit" class="secondary">Create clip</button>
      </form>
      <div class="actions">
        <button type="button" class="danger" data-delete="${escapeHtml(row.id)}">Delete</button>
      </div>
    </article>
  `).join('')
}

function renderClips(rows) {
  if (!rows.length) {
    clips.innerHTML = '<p class="empty">No clips yet.</p>'
    return
  }
  clips.innerHTML = rows.map((row) => `
    <article class="item">
      <strong>${escapeHtml(row.title || 'Clip')}</strong>
      <p class="meta">${escapeHtml(row.parent_title || row.parent_name || '')} · ${formatClock(row.duration_seconds)}</p>
      ${audioHtml(row.clipUrl)}
    </article>
  `).join('')
}

async function refresh() {
  const [saved, cut] = await Promise.all([relay('archive'), relay('clips')])
  renderArchive(Array.isArray(saved) ? saved : [])
  renderClips(Array.isArray(cut) ? cut : [])
}

async function trackRecording(id, title) {
  jobs.set(id, { id, title, state: 'downloading', kind: 'recording' })
  renderLive()
  const tick = async () => {
    if (!jobs.has(id)) return
    try {
      const status = await relay(`status?id=${encodeURIComponent(id)}`)
      jobs.set(id, { ...jobs.get(id), ...status, kind: 'recording' })
      renderLive()
      if (status.state === 'ready' || status.state === 'error') {
        jobs.delete(id)
        renderLive()
        await refresh()
        if (status.state === 'error') showNotice(status.error || 'Recording failed.')
      } else {
        setTimeout(tick, 3000)
      }
    } catch (error) {
      showNotice(error.message)
    }
  }
  setTimeout(tick, 1500)
}

async function trackMonitor(id) {
  jobs.set(id, { id, title: 'Watching', state: 'watching', kind: 'monitor', detail: 'Waiting for the Space.' })
  renderLive()
  const tick = async () => {
    if (!jobs.has(id)) return
    try {
      const status = await relay(`monitor?id=${encodeURIComponent(id)}`)
      const current = {
        id,
        title: status.title || 'Watching',
        state: status.state,
        kind: 'monitor',
        detail: status.lastReason || '',
        previewUrl: status.previewUrl,
      }
      jobs.set(id, current)
      renderLive()
      if (status.jobId) {
        jobs.delete(id)
        renderLive()
        await trackRecording(status.jobId, status.title)
        return
      }
      if (status.state === 'error' || status.state === 'cancelled' || status.state === 'ended') {
        jobs.delete(id)
        renderLive()
        return
      }
      setTimeout(tick, 4000)
    } catch (error) {
      showNotice(error.message)
    }
  }
  setTimeout(tick, 1500)
}

form.addEventListener('submit', async (event) => {
  event.preventDefault()
  showNotice('')
  const button = form.querySelector('button[type="submit"]')
  button.disabled = true
  try {
    const started = await relay('record', { method: 'POST', body: JSON.stringify({ input: input.value }) })
    input.value = ''
    await trackRecording(started.id, started.title)
  } catch (error) {
    showNotice(error.message)
  } finally {
    button.disabled = false
  }
})

document.querySelector('#watch').addEventListener('click', async () => {
  showNotice('')
  if (!input.value.trim()) {
    showNotice('Paste a Space link or ID first.')
    return
  }
  try {
    const started = await relay('monitor', { method: 'POST', body: JSON.stringify({ input: input.value }) })
    input.value = ''
    await trackMonitor(started.id)
  } catch (error) {
    showNotice(error.message)
  }
})

document.querySelector('#refresh').addEventListener('click', () => {
  refresh().catch((error) => showNotice(error.message))
})

document.body.addEventListener('click', async (event) => {
  const stop = event.target.closest('[data-stop]')
  const remove = event.target.closest('[data-delete]')
  try {
    if (stop) {
      await relay('stop', { method: 'POST', body: JSON.stringify({ id: stop.dataset.stop }) })
      showNotice('Stop requested. The recording will save what it has captured.')
    }
    if (remove) {
      if (!window.confirm('Delete this recording?')) return
      await relay(`archive?id=${encodeURIComponent(remove.dataset.delete)}`, { method: 'DELETE' })
      await refresh()
    }
  } catch (error) {
    showNotice(error.message)
  }
})

document.body.addEventListener('submit', async (event) => {
  const clipForm = event.target.closest('[data-clip]')
  if (!clipForm) return
  event.preventDefault()
  const start = parseClock(new FormData(clipForm).get('start'))
  const end = parseClock(new FormData(clipForm).get('end'))
  if (start == null || end == null || end <= start) {
    showNotice('Use a clock range such as 1:30 and 4:00.')
    return
  }
  try {
    await relay('clips', {
      method: 'POST',
      body: JSON.stringify({
        recording_id: clipForm.dataset.clip,
        title: new FormData(clipForm).get('title'),
        start_seconds: start,
        end_seconds: end,
      }),
    })
    clipForm.reset()
    await refresh()
  } catch (error) {
    showNotice(error.message)
  }
})

function boot() {
  const named = telegram?.initDataUnsafe?.user
  who.textContent = named?.first_name || ''
  if (!telegram?.initData) {
    gate.hidden = false
    app.hidden = true
    return
  }
  gate.hidden = true
  app.hidden = false
  refresh().catch((error) => showNotice(error.message))
}

boot()
