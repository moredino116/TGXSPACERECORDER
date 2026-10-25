;(async () => {
  const params = new URLSearchParams(location.search)
  if (!params.has('manage')) return

  const main = document.querySelector('main')
  const kind = params.get('manage')
  const id = params.get('id') || ''
  const tg = window.Telegram?.WebApp
  tg?.ready()
  tg?.expand()

  main.replaceChildren()
  const heading = document.createElement('h1')
  heading.textContent = kind === 'clip' ? 'Manage clip' : 'Manage recording'
  main.append(heading)
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

  const audio = document.createElement('audio')
  audio.preload = 'metadata'
  content.append(audio)
  const controls = document.createElement('div')
  controls.className = 'manage-controls'
  content.append(controls)

  function seek(value) {
    try {
      audio.currentTime = Math.max(0, Number.isFinite(audio.duration)
        ? Math.min(value, audio.duration) : value)
    } catch {
      status.textContent = 'That position is not available yet.'
    }
  }
  button('Forward 30 sec', () => seek(audio.currentTime + 30), controls)
  const play = button('Play', async () => {
    try {
      if (audio.paused) await audio.play()
      else audio.pause()
    } catch {
      status.textContent = 'Playback could not start. Try refreshing the audio.'
    }
  }, controls)
  button('Rewind 15 sec', () => seek(audio.currentTime - 15), controls)
  audio.onplay = () => { play.textContent = 'Pause' }
  audio.onpause = audio.onended = () => { play.textContent = 'Play' }

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
  function update() {
    const duration = Number.isFinite(audio.duration) && audio.duration > 0
      ? audio.duration : 0
    slider.disabled = !duration
    slider.max = String(duration || 1)
    slider.value = String(Math.min(audio.currentTime || 0, duration || 1))
    time.textContent = `${clock(audio.currentTime)} / ${duration ? clock(duration) : 'Not available yet'}`
  }
  audio.ontimeupdate = audio.ondurationchange = update
  audio.onerror = () => {
    status.textContent = 'Audio unavailable, expired, or not playable. Try refreshing.'
  }

  async function loadAudio() {
    status.textContent = 'Loading audio…'
    try {
      const data = await request('/api/playback', 'POST', { kind, id })
      const url = new URL(data.url)
      if (url.protocol !== 'https:') throw new Error('Invalid playback URL.')
      audio.src = url.href
      audio.load()
      status.textContent = ''
    } catch (error) {
      status.textContent = error.message
    }
  }
  button('Refresh audio', loadAudio)

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
    const start = field('Start', '30:00')
    const end = field('End', '31:00')
    const note = document.createElement('p')
    note.textContent = 'Formats: 30, 30:00, 3:30:00. Saves a separate copy; original unchanged.'
    form.append(note)
    const create = document.createElement('button')
    create.type = 'submit'
    create.textContent = 'Create clip copy'
    form.append(create)
    const result = document.createElement('p')
    result.setAttribute('role', 'status')
    form.append(result)
    let rendering = false

    function parse(value) {
      if (!/^\d+(?:\.\d+)?(?::\d+(?:\.\d+)?){0,2}$/.test(value.trim())) return null
      const parts = value.trim().split(':').map(Number)
      if (parts.slice(1).some(n => n >= 60)) return null
      const seconds = parts.reduce((a, b) => a * 60 + b, 0)
      return Number.isFinite(seconds) ? seconds : null
    }
    form.onsubmit = async event => {
      event.preventDefault()
      if (rendering) return
      const a = parse(start.value), b = parse(end.value)
      if (a === null || b === null || b - a < 1 || b - a > 14400) {
        result.textContent = 'Enter a valid range from 1 second to 4 hours.'
        return
      }
      rendering = true
      create.disabled = true
      result.textContent = 'Creating clip…'
      try {
        const data = await call('POST', `space/recordings/${item}/clips`, {
          title: title.value.trim(), start_seconds: a, end_seconds: b,
          enhance: false,
        })
        if (!/^[A-Za-z0-9_-]{1,100}$/.test(data.id || '')) {
          throw new Error('No valid clip ID returned.')
        }
        result.textContent = 'Clip created. '
        const link = document.createElement('a')
        link.textContent = 'Open clip'
        link.href = `?manage=clip&id=${encodeURIComponent(data.id)}`
        result.append(link)
      } catch (error) {
        result.textContent = error.message +
          ' If the request timed out, check /clips before retrying.'
      } finally {
        rendering = false
        create.disabled = false
      }
    }
    content.append(form)
  }

  const actions = document.createElement('div')
  actions.className = 'manage-controls'
  content.append(actions)
  let updating = false
  async function act(action) {
    if (updating) return
    if (action === 'delete' && !confirm(
      'Schedule deletion with a two-hour Restore window? ' +
      'Deleting an active recording also requests capture stop.'
    )) return
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
  button('Delete', () => act('delete'), actions)
  button('Archive', () => act('archive'), actions)
  update()
  await loadAudio()
})().catch(() => {
  const status = document.querySelector('[role="status"]')
  if (status) status.textContent = 'The Manage page could not initialize.'
})
