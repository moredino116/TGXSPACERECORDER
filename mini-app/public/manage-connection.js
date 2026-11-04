;(async () => {
  // Compact X access row v1
  const params = new URLSearchParams(location.search)
  const kind = params.get('manage')
  const id = params.get('id') || ''
  if (!['space', 'clip'].includes(kind) ||
      !/^[A-Za-z0-9_-]{1,100}$/.test(id)) return

  const main = document.querySelector('main')
  const tg = window.Telegram?.WebApp
  if (!main || !tg?.initData) return

  const row = document.createElement('section')
  row.className = 'connection-row'
  row.setAttribute('aria-label', 'X account access')
  main.insertBefore(row, main.children[1] || null)

  const setupUrl = '?' + new URLSearchParams({
    connect: 'x', return_kind: kind, return_id: id,
  }).toString()

  function display(text, label, retry = false) {
    row.replaceChildren()
    const state = document.createElement('p')
    state.textContent = text
    state.setAttribute('role', 'status')
    row.append(state)

    if (label) {
      const action = document.createElement(retry ? 'button' : 'a')
      action.textContent = label
      if (retry) {
        action.type = 'button'
        action.onclick = load
      } else {
        action.href = setupUrl
      }
      row.append(action)
    }

    const note = document.createElement('small')
    note.className = 'connection-note'
    note.textContent =
      'Public playback does not require X access. ' +
      'Connect X uses a private recorder-owned sign-in browser when account access is needed.'
    row.append(note)
  }

  let busy = false
  async function load() {
    if (busy) return
    busy = true
    display('X access: Checking saved status…', null)
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 8000)
    try {
      const response = await fetch('/relay/x-connections', {
        method: 'GET',
        cache: 'no-store',
        signal: ctrl.signal,
        headers: { 'x-telegram-init-data': tg.initData },
      })
      if (!response.ok) throw new Error('Unverified status')
      const data = await response.json()
      if (!Array.isArray(data) || data.some(item =>
        !item || typeof item.id !== 'string' ||
        !/^[A-Za-z0-9_-]{1,100}$/.test(item.id) ||
        typeof item.status !== 'string'
      )) throw new Error('Unverified status')

      if (data.length === 0) {
        display('X access: Not connected', 'Connect X')
      } else if (data.length > 1) {
        display('X access: Account selection required', 'Manage connection')
      } else {
        const saved = data[0]
        const usable = saved.status === 'active' &&
          !saved.revoked_at &&
          (!saved.expires_at || Date.parse(saved.expires_at) > Date.now())
        if (usable) {
          const handle = typeof saved.x_handle === 'string' &&
            /^[A-Za-z0-9_]{1,100}$/.test(saved.x_handle)
            ? '@' + saved.x_handle : 'saved account'
          display('Connected: ' + handle, 'Manage connection')
        } else {
          display('X access: Reconnect required', 'Reconnect X')
        }
      }
    } catch {
      display('X access: Status unavailable', 'Check again', true)
    } finally {
      clearTimeout(timer)
      busy = false
    }
  }

  await load()
})()
