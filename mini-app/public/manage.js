;(async () => {
  const params = new URLSearchParams(location.search)
  if (!params.has('manage')) return

  const main = document.querySelector('main')
  const kind = params.get('manage')
  const id = params.get('id') || ''
  const tg = window.Telegram?.WebApp
  tg?.ready()
  tg?.expand()

  // Mfer palette v1
  main.className = [main.className, 'manage-view'].filter(Boolean).join(' ')
  main.replaceChildren()
  const heading = document.createElement('h1')
  heading.textContent = kind === 'clip' ? 'Manage clip' : 'Manage recording'
  // Player layout v3
  const header = document.createElement('div')
  header.className = 'manage-heading'
  header.append(heading)
  main.append(header)
  const status = document.createElement('p')
  status.setAttribute('role', 'status')
  main.append(status)

  if (!['space', 'clip'].includes(kind) ||
      !/^[A-Za-z0-9_-]{1,100}$/.test(id)) {
    status.textContent = 'Invalid Manage link.'
    return
  }
  if (!tg?.initData) {
    status.textContent = 'Open this item from the bot in a private Telegram chat.'
    return
  }

  async function request(url, method = 'GET', body) {
    const response = await fetch(url, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-telegram-init-data': tg.initData,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`)
    return data
  }
  const call = (method, path, body) =>
    request('/relay/' + path, method, body)
  const item = encodeURIComponent(id)
  const content = document.createElement('section')
  main.append(content)

  function button(text, handler, parent = content) {
    const node = document.createElement('button')
    node.type = 'button'
    node.textContent = text
    const tone = text === 'Delete' ? 'danger'
      : (text === 'Archive' || text === 'Share') ? 'gold'
      : (text === 'Play' || text === 'Preview selection' || text === 'Preview') ? 'primary'
      : 'neutral'
    node.setAttribute('data-tone', tone)
    node.onclick = handler
    parent.append(node)
    return node
  }
  function clock(value) {
    const n = Math.max(0, Math.floor(value || 0))
    const h = Math.floor(n / 3600)
    const m = Math.floor(n % 3600 / 60)
    const s = String(n % 60).padStart(2, '0')
    return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
  }

  // Selection preview v1
  let previewEnd = null
  let previewStatus = null
  let updateSelection = () => {}

  function stopPreview(message) {
    if (previewEnd !== null && previewStatus) {
      previewStatus.textContent = message
    }
    previewEnd = null
  }

  const audio = document.createElement('audio')
  audio.preload = 'metadata'
  content.append(audio)
  const controls = document.createElement('div')
  controls.className = 'manage-controls'
  // Player controls are rendered below seek/time.


  function seek(value) {
    stopPreview('Preview ended; full-item playback controls are active.')
    const duration = audio.duration
    if (!Number.isFinite(duration) || duration <= 0 ||
        !Number.isFinite(value)) {
      status.textContent = 'Audio duration is not available yet.'
      return
    }
    try {
      audio.currentTime = Math.max(0, Math.min(value, duration))
    } catch {
      status.textContent = 'That position is not available yet.'
    }
  }
  const play = button('Play', async () => {
    try {
      stopPreview('Preview ended; full-item playback controls are active.')
      if (audio.paused) await audio.play()
      else audio.pause()
    } catch {
      status.textContent = 'Playback could not start. Try refreshing the audio.'
    }
  }, controls)
  button('Forward 30 sec', () => seek(audio.currentTime + 30), controls)
  button('Forward 6 min', () => seek(audio.currentTime + 360), controls)
  button('Rewind 15 sec', () => seek(audio.currentTime - 15), controls)
  audio.onplay = () => { play.textContent = 'Pause' }
  audio.onpause = audio.onended = () => {
    play.textContent = 'Play'
    stopPreview('Preview paused.')
  }

  const slider = document.createElement('input')
  slider.type = 'range'
  slider.min = '0'
  slider.max = '1'
  slider.step = '0.1'
  slider.value = '0'
  slider.disabled = true
  slider.setAttribute('aria-label', 'Seek recording')
  slider.oninput = () => seek(Number(slider.value))
  content.append(slider)
  const time = document.createElement('p')
  content.append(time)
  content.append(controls)
  function update() {
    if (previewEnd !== null && audio.currentTime >= previewEnd) {
      const end = previewEnd
      stopPreview('Preview finished.')
      audio.pause()
      audio.currentTime = end
    }
    const duration = Number.isFinite(audio.duration) && audio.duration > 0
      ? audio.duration : 0
    slider.disabled = !duration
    slider.max = String(duration || 1)
    slider.value = String(Math.min(audio.currentTime || 0, duration || 1))
    time.textContent = `${clock(audio.currentTime)} / ${duration ? clock(duration) : 'Not available yet'}`
  }
  audio.ontimeupdate = audio.ondurationchange = () => {
    update()
    updateSelection()
  }
  audio.onerror = () => {
    status.textContent = 'Audio unavailable, expired, or not playable. Try refreshing.'
  }

  async function loadAudio() {
    stopPreview('Audio refreshed. Preview the selection again when ready.')
    status.textContent = 'Loading audio…'
    try {
      const data = await request('/api/playback', 'POST', { kind, id })
      const url = new URL(data.url)
      if (url.protocol !== 'https:') throw new Error('Invalid playback URL.')
      audio.src = url.href
      audio.load()
      status.textContent = ''
      updateSelection()
    } catch (error) {
      status.textContent = error.message
    }
  }
  button('Refresh audio', loadAudio, header)
  button('X Login', () => {
    location.href = '?' + new URLSearchParams({
      connect: 'x', return_kind: kind, return_id: id,
    }).toString()
  }, header)
  // Selected-item actions sit below the player; account access stays beside Refresh.
  const actions = document.createElement('div')
  actions.className = 'manage-actions'
  content.append(actions)
  if (kind === 'space') button('Play', () => play.onclick(), actions)

  if (kind === 'space') {
    const form = document.createElement('form')
    const titleHeading = document.createElement('h2')
    titleHeading.textContent = 'Create a clip copy'
    form.append(titleHeading)
    function field(label, placeholder) {
      const node = document.createElement('label')
      node.textContent = label
      const input = document.createElement('input')
      input.placeholder = placeholder
      node.append(input)
      form.append(node)
      return input
    }
    const title = field('Title (optional)', 'Clip')
    title.maxLength = 200
    const start = field('Beginning', ':00')
    const end = field('End', '00:30')
    const note = document.createElement('p')
    note.textContent = 'Formats: :00, 00:00, 00:00:00. Maximum 15 minutes; original unchanged.'
    form.append(note)
    const create = document.createElement('button')
    create.type = 'submit'
    create.textContent = 'Generate'
    create.setAttribute('data-tone', 'primary')
    const interpreted = document.createElement('p')
    const selectedDuration = document.createElement('p')
    form.append(interpreted, selectedDuration)

    const previewControls = document.createElement('div')
    previewControls.className = 'manage-controls'
    form.append(previewControls)
    const preview = button('Preview', previewSelection, previewControls)
    preview.disabled = true
    previewControls.append(create)

    previewStatus = document.createElement('p')
    previewStatus.setAttribute('role', 'status')
    form.append(previewStatus)
    const result = document.createElement('p')
    result.setAttribute('role', 'status')
    form.append(result)
    let rendering = false

    function parse(value) {
      value = value.trim().replace(/^:(\d{1,2})$/, '0:$1')
      if (!/^\d+(?:\.\d+)?(?::\d+(?:\.\d+)?){0,2}$/.test(value.trim())) return null
      const parts = value.trim().split(':').map(Number)
      if (parts.slice(1).some(n => n >= 60)) return null
      const seconds = parts.reduce((a, b) => a * 60 + b, 0)
      return Number.isFinite(seconds) ? seconds : null
    }
    function readSelection() {
      const a = parse(start.value)
      const b = parse(end.value)
      return a !== null && b !== null && b - a >= 1 && b - a <= 900 ? { a, b } : null
    }

    function available(range) {
      return range && Number.isFinite(audio.duration) &&
        audio.duration > 0 && range.b <= audio.duration && Boolean(audio.src)
    }

    updateSelection = () => {
      const range = readSelection()
      interpreted.textContent = range
        ? `Interpreted selection: ${clock(range.a)} → ${clock(range.b)}`
        : 'Interpreted selection: enter a valid Start and End.'
      selectedDuration.textContent = range
        ? `Clip duration: ${clock(range.b - range.a)}`
        : 'Clip duration: —'
      preview.disabled = !available(range)
    }

    function selectionChanged() {
      const wasPreviewing = previewEnd !== null
      stopPreview('Selection changed. Preview again to hear the new range.')
      if (wasPreviewing) audio.pause()
      updateSelection()
    }
    start.oninput = end.oninput = selectionChanged

    async function previewSelection() {
      const range = readSelection()
      if (!range) {
        previewStatus.textContent = 'Enter a valid selection of at least 1 second.'
        return
      }
      if (!Number.isFinite(audio.duration) || audio.duration <= 0 || !audio.src) {
        previewStatus.textContent = 'Audio duration is not available yet.'
        return
      }
      if (range.b > audio.duration) {
        previewStatus.textContent = 'Selection exceeds available audio.'
        return
      }
      stopPreview('Starting a new preview.')
      try {
        audio.currentTime = range.a
        previewEnd = range.b
        previewStatus.textContent =
          `Previewing ${clock(range.a)} → ${clock(range.b)}.`
        await audio.play()
      } catch {
        stopPreview('Preview could not start. Try refreshing the audio.')
        audio.pause()
      }
    }
    let generated = null
    const clipActions = document.createElement('div')
    clipActions.className = 'manage-controls'
    clipActions.hidden = true
    form.append(clipActions)
    const shareClip = button('Share', () => commitClip('share'), clipActions)
    const archiveClip = button('Archive', () => commitClip('archive'), clipActions)
    const discardClip = button('Delete', () => {
      generated = null
      clipActions.hidden = true
      result.textContent = 'Temporary preview cleared. The original recording is unchanged.'
      stopPreview('Preview cleared.')
      audio.pause()
    }, clipActions)
    let committing = false

    async function commitClip(action) {
      if (!generated || committing) return
      committing = true
      ;[shareClip, archiveClip, discardClip].forEach(node => { node.disabled = true })
      result.textContent = action === 'archive' ? 'Saving clip to Archive…' : 'Preparing upload-ready clip…'
      try {
        const data = await call('POST', `space/recordings/${item}/clips`, {
          title: generated.title, start_seconds: generated.a, end_seconds: generated.b, enhance: false,
        })
        if (!/^[A-Za-z0-9_-]{1,100}$/.test(data.id || '')) throw new Error('Clip could not be confirmed.')
        if (action === 'archive') {
          const archived = await call('POST', `retention/items/clip/${data.id}/archive`)
          if (archived.ok !== true || !archived.item?.archived_at) throw new Error('Archive could not be confirmed.')
          result.textContent = 'Clip archived indefinitely.'
        } else {
          result.textContent = 'Clip saved for sharing. Open it to prepare the upload-ready export.'
        }
        const link = document.createElement('a')
        link.textContent = action === 'archive' ? 'Manage archived clip' : 'Manage shared clip'
        link.href = `?manage=clip&id=${encodeURIComponent(data.id)}`
        result.append(' ', link)
        generated = null
        clipActions.hidden = true
      } catch (error) {
        result.textContent = error.message || 'Clip could not be saved.'
      } finally {
        committing = false
        ;[shareClip, archiveClip, discardClip].forEach(node => { node.disabled = false })
      }
    }

    form.onsubmit = async event => {
      event.preventDefault()
      if (rendering || committing) return
      const a = parse(start.value), b = parse(end.value)
      if (a === null || b === null || b - a < 1 || b - a > 900) {
        result.textContent = 'Enter a range from 1 second to 15 minutes, within the source recording.'
        return
      }
      if (!Number.isFinite(audio.duration) || audio.duration <= 0 || !audio.src) {
        result.textContent = 'Audio duration is not available yet. Refresh and retry.'
        return
      }
      if (b > audio.duration) { result.textContent = 'Selection exceeds available audio.'; return }
      generated = { a, b, title: title.value.trim() }
      clipActions.hidden = false
      result.textContent = `Temporary preview generated: ${clock(a)} → ${clock(b)}. Select Share, Archive, or Delete.`
      await previewSelection()
    }

    content.append(form)
  }

  let updating = false
  async function act(action) {
    if (updating) return
    updating = true
    const buttons = [...actions.querySelectorAll('button')]
    buttons.forEach(b => { b.disabled = true })
    try {
      const path = action === 'archive'
        ? kind === 'space' ? `space/recordings/${item}/archive`
          : `retention/items/clip/${item}/archive`
        : kind === 'space' ? `space/archive/${item}` : `space/clips/${item}`
      const data = await call(action === 'archive' ? 'POST' : 'DELETE', path)
      if (data.ok !== true) throw new Error('Operation could not be confirmed.')
      if (action === 'delete') {
        audio.pause()
        audio.removeAttribute('src')
        audio.load()
        content.remove()
        header.remove()
        status.textContent = 'Deletion scheduled. Use /restore within two hours.'
      } else {
        status.textContent = data.item?.deleted_at
          ? 'Archived, but still pending deletion. Use /restore separately.'
          : 'Archived. Active capture has not been stopped.'
      }
    } catch (error) {
      status.textContent = error.message
    } finally {
      updating = false
      buttons.forEach(b => { b.disabled = false })
    }
  }
  // Selected audio download v1
  const sharing = document.createElement('section')
  sharing.className = 'share-tools'
  sharing.id = 'share-tools'
  sharing.hidden = true
  const shareHeading = document.createElement('h2')
  shareHeading.textContent = 'Share & export'
  sharing.append(shareHeading)
  const downloadNote = document.createElement('p')
  downloadNote.textContent =
    'Prepare a temporary download link for this selected item. ' +
    'Anyone with that link can access it while it remains valid. ' +
    'This does not change the original or its retention.'
  sharing.append(downloadNote)
  const downloadResult = document.createElement('p')
  downloadResult.setAttribute('role', 'status')
  let preparingDownload = false

  button('Prepare audio download', async () => {
    if (preparingDownload) return
    preparingDownload = true
    downloadResult.replaceChildren()
    downloadResult.textContent = 'Preparing audio download…'
    try {
      const data = await request('/api/playback', 'POST', {
        kind, id, download: true,
      })
      const url = new URL(data.url)
      if (url.protocol !== 'https:') throw new Error('Invalid download URL.')
      if (!document.documentElement.contains(sharing)) return
      downloadResult.textContent = ''
      const link = document.createElement('a')
      link.textContent = 'Download audio'
      link.href = url.href
      link.target = '_blank'
      link.rel = 'noopener noreferrer'
      downloadResult.append(link)
      const note = document.createElement('span')
      note.textContent = ' — temporary link; availability is checked when opened.'
      downloadResult.append(note)
    } catch {
      downloadResult.textContent =
        'Download could not be prepared. Refresh the selected item and retry.'
    } finally {
      preparingDownload = false
    }
  }, sharing)
  sharing.append(downloadResult)
  // Sharing drafts v1
  const shareFields = document.createElement('div')
  shareFields.className = 'share-fields'
  sharing.append(shareFields)

  const titleLabel = document.createElement('label')
  titleLabel.textContent = 'Share title'
  const shareTitle = document.createElement('input')
  shareTitle.type = 'text'
  shareTitle.maxLength = 200
  shareTitle.value = `${kind === 'clip' ? 'Clip' : 'Recording'} ${id}`
  shareTitle.setAttribute('aria-label', 'Share title')
  titleLabel.append(shareTitle)
  shareFields.append(titleLabel)

  const messageLabel = document.createElement('label')
  messageLabel.textContent = 'Message (optional)'
  const shareMessage = document.createElement('textarea')
  shareMessage.maxLength = 1000
  shareMessage.rows = 3
  shareMessage.setAttribute('aria-label', 'Share message')
  messageLabel.append(shareMessage)
  shareFields.append(messageLabel)

  const shareResult = document.createElement('div')
  shareResult.className = 'share-result'
  shareResult.setAttribute('role', 'status')
  let preparingShare = false

  button('Prepare sharing links', async () => {
    if (preparingShare) return
    preparingShare = true
    shareResult.replaceChildren()
    shareResult.textContent = 'Preparing temporary sharing links…'
    try {
      const title = shareTitle.value.replace(/[\r\n]+/g, ' ').trim().slice(0, 200)
        || `${kind === 'clip' ? 'Clip' : 'Recording'} ${id}`
      const message = shareMessage.value.trim().slice(0, 1000)
      const data = await request('/api/playback', 'POST', { kind, id })
      const url = new URL(data.url)
      if (url.protocol !== 'https:') throw new Error('Invalid sharing URL.')
      if (!document.documentElement.contains(sharing)) return

      shareResult.textContent = ''
      const notice = document.createElement('p')
      notice.textContent =
        'Temporary bearer link: anyone receiving it can access the audio ' +
        'while the link is valid and the item remains available. ' +
        'Regenerate after expiry. Email and Telegram options share a link, ' +
        'not an attached audio file.'
      shareResult.append(notice)

      const copyLabel = document.createElement('label')
      copyLabel.textContent = 'Copyable playback link'
      const copy = document.createElement('textarea')
      copy.readOnly = true
      copy.rows = 3
      copy.value = url.href
      copy.setAttribute('aria-label', 'Copyable playback link')
      copyLabel.append(copy)
      shareResult.append(copyLabel)

      const body = [
        title, message,
        'Temporary audio link (availability and expiry still apply):',
        url.href,
      ].filter(Boolean).join('\r\n\r\n')

      const email = document.createElement('a')
      email.textContent = 'Open email draft'
      email.href = 'mailto:?subject=' + encodeURIComponent(title) +
        '&body=' + encodeURIComponent(body)
      shareResult.append(email)

      const telegramUrl = new URL('https://t.me/share/url')
      telegramUrl.searchParams.set('url', url.href)
      telegramUrl.searchParams.set('text', [
        title, message, 'Temporary audio link; expiry applies.',
      ].filter(Boolean).join('\n\n'))
      const telegram = document.createElement('a')
      telegram.textContent = 'Choose Telegram chat'
      telegram.href = telegramUrl.href
      telegram.target = '_blank'
      telegram.rel = 'noopener noreferrer'
      shareResult.append(telegram)
    } catch {
      shareResult.textContent =
        'Sharing links could not be prepared. Refresh the selected item and retry.'
    } finally {
      preparingShare = false
    }
  }, sharing)
  sharing.append(shareResult)
  const shareToggle = button('Share', () => {
    sharing.hidden = !sharing.hidden
    shareToggle.setAttribute('aria-expanded', String(!sharing.hidden))
  }, actions)
  shareToggle.setAttribute('aria-expanded', 'false')
  shareToggle.setAttribute('aria-controls', sharing.id)
  if (kind === 'clip') button('Archive', () => act('archive'), actions)
  button('Delete', () => act('delete'), actions)
  content.append(sharing)
  update()
  await loadAudio()
})().catch(() => {
  const status = document.querySelector('[role="status"]')
  if (status) status.textContent = 'The Manage page could not initialize.'
})

