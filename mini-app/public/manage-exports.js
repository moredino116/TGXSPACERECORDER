;(async () => {
  // MP4 export interface v1
  const params = new URLSearchParams(location.search)
  const kind = params.get('manage')
  const id = params.get('id') || ''
  const tg = window.Telegram?.WebApp
  const sharing = document.querySelector('.share-tools')
  if (!sharing || !tg?.initData ||
      !['space', 'clip'].includes(kind) ||
      !/^[A-Za-z0-9_-]{1,100}$/.test(id)) return

  const panel = document.createElement('section')
  panel.className = 'export-tools'
  sharing.append(panel)
  let closed = false
  let creating = false
  let retryParent = null
  let pollTimer = null
  let epoch = 0
  let failures = 0
  let lastActive = false
  const controllers = new Set()
  const operations = new Set()
  const connected = () =>
    !closed && document.documentElement.contains(panel)

  function node(tag, text, parent = panel) {
    const element = document.createElement(tag)
    if (text !== undefined) element.textContent = text
    parent.append(element)
    return element
  }
  function button(text, handler, parent = panel, tone = 'neutral') {
    const element = node('button', text, parent)
    element.type = 'button'
    element.setAttribute('data-tone', tone)
    element.onclick = handler
    return element
  }
  function safeError(message) {
    const error = new Error(message)
    error.safe = true
    return error
  }

  async function request(url, method = 'GET', body) {
    const controller = new AbortController()
    controllers.add(controller)
    const timer = setTimeout(() => controller.abort(), 10000)
    try {
      const response = await fetch(url, {
        method, cache: 'no-store', signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          'x-telegram-init-data': tg.initData,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      const data = await response.json()
      if (!response.ok) throw new Error('Unverified response')
      return data
    } finally {
      clearTimeout(timer)
      controllers.delete(controller)
    }
  }

  function validJob(job) {
    return job && /^e[a-f0-9]{32}$/.test(job.id || '') &&
      job.kind === kind && job.sourceId === id &&
      ['landscape720', 'landscape1080'].includes(job.preset) &&
      ['queued', 'rendering', 'completed', 'failed', 'removed'].includes(job.status)
  }

  node('h3', 'Cover-image MP4')
  node('p',
    'Uses the full selected item. Create a clip copy first for a shorter range. ' +
    'Exports require a completed recording or clip. After a job is confirmed, ' +
    'rendering continues on the server even if you close this page.')
  node('p',
    'PNG/JPEG cover: up to 1 MiB and 4096 × 4096 pixels. ' +
    'These are technical video presets, not guarantees of platform upload eligibility.')

  const form = node('form')
  const coverLabel = node('label', 'Cover image', form)
  const cover = node('input', undefined, coverLabel)
  cover.type = 'file'
  cover.accept = 'image/png,image/jpeg'
  cover.setAttribute('aria-label', 'Export cover')

  const presetLabel = node('label', 'Format', form)
  const preset = node('select', undefined, presetLabel)
  preset.setAttribute('aria-label', 'Export preset')
  for (const [value, text] of [
    ['landscape720', 'X/Twitter · 720p landscape'],
    ['landscape1080', 'YouTube · 1080p landscape'],
  ]) {
    const option = node('option', text, preset)
    option.value = value
  }
  preset.value = 'landscape720'

  const create = node('button', 'Create MP4', form)
  create.type = 'submit'
  create.setAttribute('data-tone', 'primary')
  const mode = node('p', '')
  const submission = node('p', '')
  submission.setAttribute('role', 'status')
  const resetRetry = button('Reset retry mode', () => {
    retryParent = null
    mode.textContent = ''
    resetRetry.hidden = true
  })
  resetRetry.hidden = true

  const refreshButton = button('Refresh exports', refresh)
  const listStatus = node('p', '')
  listStatus.setAttribute('role', 'status')
  const list = node('div')
  list.className = 'export-list'

  function chooseRetry(job) {
    retryParent = job.id
    mode.textContent =
      'Explicit new attempt for ' + job.id +
      '. Select the cover and format, then click Create MP4.'
    resetRetry.hidden = false
    cover.focus?.()
  }

  function renderJobs(jobs) {
    list.replaceChildren()
    if (!jobs.length) {
      node('p', 'No saved exports for this item.', list)
      return
    }
    for (const job of jobs) {
      const card = node('article', undefined, list)
      card.className = 'export-card'
      node('p', job.id + ' · ' + job.preset, card)
      const wording = {
        queued: 'Queued on server; waits while capture or clip work is busy.',
        rendering: 'Rendering on server.',
        completed: 'MP4 completed.',
        failed: 'Export failed or was interrupted. No successful output is confirmed.',
      }
      node('p', wording[job.status] || 'Export removed.', card)
      const actions = node('div', undefined, card)
      actions.className = 'export-actions'
      const result = node('p', '', card)
      result.setAttribute('role', 'status')

      if (job.status === 'completed') {
        button('Prepare MP4 download', async () => {
          if (operations.has(job.id)) return
          operations.add(job.id)
          result.replaceChildren()
          result.textContent = 'Checking export availability…'
          try {
            const data = await request('/api/export-download', 'POST', { id: job.id })
            const url = new URL(data.url)
            if (url.protocol !== 'https:' ||
                url.pathname !== '/api/space/exports/' + job.id + '/file') {
              throw new Error('Invalid download URL')
            }
            if (!connected()) return
            result.textContent = ''
            const link = node('a', 'Download MP4', result)
            link.href = url.href
            link.target = '_blank'
            link.rel = 'noopener noreferrer'
            node('span', ' — temporary link; source availability is checked when opened.', result)
          } catch {
            if (connected()) result.textContent =
              'Download was not confirmed. Refresh exports and retry.'
          } finally {
            operations.delete(job.id)
          }
        }, actions, 'primary')
      }

      if (job.status === 'failed') {
        button('Retry with cover', () => chooseRetry(job), actions)
      }

      if (['completed', 'failed'].includes(job.status)) {
        button('Remove generated MP4', async () => {
          if (operations.has(job.id)) return
          operations.add(job.id)
          result.textContent = 'Removing generated export only…'
          try {
            const data = await request(
              '/relay/space/exports/' + job.id, 'DELETE'
            )
            if (data.ok !== true || data.job?.id !== job.id ||
                data.job.status !== 'removed') throw new Error('Unverified removal')
            if (connected()) await refresh()
          } catch {
            if (connected()) result.textContent =
              'Removal was not confirmed. Refresh exports before retrying.'
          } finally {
            operations.delete(job.id)
          }
        }, actions, 'danger')
        node('small',
          'Remove deletes this generated export immediately, not the source audio. ' +
          'The export itself has no Restore window.', card)
      }
    }
  }

  async function refresh() {
    if (!connected()) return
    const current = ++epoch
    clearTimeout(pollTimer)
    refreshButton.disabled = true
    try {
      const data = await request(
        '/relay/space/exports/source/' + kind + '/' + encodeURIComponent(id)
      )
      if (!connected() || current !== epoch) return
      if (data.ok !== true || !Array.isArray(data.jobs) ||
          data.jobs.some(job => !validJob(job))) {
        throw new Error('Unverified list')
      }
      const jobs = data.jobs.filter(job => job.status !== 'removed')
      renderJobs(jobs)
      failures = 0
      lastActive = jobs.some(job => ['queued', 'rendering'].includes(job.status))
      listStatus.textContent = lastActive
        ? 'Status refreshes while server work is pending.'
        : 'Export list refreshed.'
      if (lastActive) pollTimer = setTimeout(refresh, 3000)
    } catch {
      if (!connected() || current !== epoch) return
      failures++
      listStatus.textContent =
        'Export status could not be confirmed. A job may still be running. ' +
        'Refresh the list; do not assume it failed.'
      if (lastActive && failures < 3) pollTimer = setTimeout(refresh, 3000)
    } finally {
      if (current === epoch) refreshButton.disabled = false
    }
  }

  form.onsubmit = async event => {
    event.preventDefault()
    if (creating || !connected()) return
    creating = true
    create.disabled = true
    try {
      const file = cover.files?.[0]
      if (!file || file.size < 1 || file.size > 1048576) {
        throw safeError('Select a PNG/JPEG cover no larger than 1 MiB. No export was submitted.')
      }
      if (!['landscape720', 'landscape1080'].includes(preset.value)) {
        throw safeError('Select a supported video preset. No export was submitted.')
      }
      const bytes = new Uint8Array(await file.arrayBuffer())
      const png = bytes.length >= 24 &&
        [137,80,78,71,13,10,26,10].every((value, i) => bytes[i] === value)
      const jpeg = bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216
      if ((!png && !jpeg) || bytes.length > 1048576) {
        throw safeError('The selected file is not a supported PNG/JPEG cover. No export was submitted.')
      }
      if (!crypto?.subtle) {
        throw safeError('Secure browser hashing is unavailable. No export was submitted.')
      }

      let binary = ''
      for (let i = 0; i < bytes.length; i += 32768) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 32768))
      }
      const coverBase64 = btoa(binary)
      const encoded = new TextEncoder().encode(
        JSON.stringify([kind, id, preset.value, coverBase64])
      )
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoded))
      const fingerprint = [...digest].map(value =>
        value.toString(16).padStart(2, '0')).join('')
      const requestKey = retryParent
        ? 'retry_' + retryParent + '_' + fingerprint.slice(0, 32)
        : 'export_' + fingerprint

      submission.textContent = 'Submitting export to the server…'
      const data = await request('/relay/space/exports', 'POST', {
        requestKey, kind, sourceId: id,
        preset: preset.value, coverBase64,
      })
      if (data.ok !== true || !validJob(data.job)) throw new Error('Unverified receipt')
      if (!connected()) return

      if (data.job.status === 'removed') {
        chooseRetry(data.job)
        submission.textContent =
          'This matching export was previously removed. ' +
          'Click Create MP4 again only if you want an explicit new attempt.'
      } else {
        submission.textContent =
          'Server confirmed export ' + data.job.id + ': ' + data.job.status +
          '. You may close this page; server work does not depend on it.'
      }
      await refresh()
    } catch (error) {
      if (connected()) submission.textContent = error.safe
        ? error.message
        : 'Export submission was not confirmed. Refresh the export list. ' +
          'Retrying the same cover, preset, and attempt uses the same request key.'
    } finally {
      creating = false
      create.disabled = false
    }
  }

  window.addEventListener?.('pagehide', () => {
    closed = true
    clearTimeout(pollTimer)
    for (const controller of controllers) controller.abort()
  })
  await refresh()
})()

