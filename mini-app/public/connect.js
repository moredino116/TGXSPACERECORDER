
;(async () => {
  const params = new URLSearchParams(location.search)
  const requestId = params.get('request')
  if (params.get('connect') !== 'x' || params.has('manage')) return
  const main = document.querySelector('main')
  if (!main) return
  // Exact-item connection return v1
  main.className = [main.className, 'manage-view'].filter(Boolean).join(' ')
  main.replaceChildren()

  const heading = document.createElement('h1')
  heading.textContent = 'Connect X'
  main.append(heading)

  const status = document.createElement('p')
  status.setAttribute('role', 'status')
  main.append(status)

  const tg = window.Telegram?.WebApp
  tg?.ready()
  tg?.expand()
  if (!tg?.initData) {
    status.textContent = 'Open account setup from the bot in Telegram.'
    return
  }

  if (requestId !== null &&
      !/^[A-Za-z0-9_-]{1,100}$/.test(requestId)) {
    status.textContent = 'Invalid saved request link. Return to the bot.'
    return
  }

  const returnKind = params.get('return_kind')
  const returnId = params.get('return_id')
  if (['space', 'clip'].includes(returnKind) &&
      /^[A-Za-z0-9_-]{1,100}$/.test(returnId || '')) {
    const back = document.createElement('a')
    back.textContent = 'Back to selected item'
    back.href = '?' + new URLSearchParams({
      manage: returnKind, id: returnId,
    }).toString()
    main.append(back)
  }

  const panel = document.createElement('section')
  main.append(panel)
  let current = null
  let busy = false
  let requestBusy = false

  async function call(method, path, body) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 25000)
    try {
      const response = await fetch('/relay/' + path, {
        method,
        signal: ctrl.signal,
        cache: 'no-store',
        headers: {
          'content-type': 'application/json',
          'x-telegram-init-data': tg.initData,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      const data = await response.json().catch(() => null)
      if (!response.ok || !data) {
        throw new Error('Request could not be confirmed. Refresh connection status before retrying.')
      }
      return data
    } finally {
      clearTimeout(timer)
    }
  }

  function button(label, handler) {
    const node = document.createElement('button')
    node.type = 'button'
    node.textContent = label
    node.onclick = handler
    panel.append(node)
    return node
  }


  function showJob(jobId) {
    if (typeof jobId !== 'string' ||
        !/^[A-Za-z0-9_-]{1,100}$/.test(jobId)) {
      throw new Error('Invalid recording job response')
    }
    status.textContent =
      'Recording job confirmed: ' + jobId +
      '. Check /process in Telegram for capture progress. ' +
      'This screen does not verify downloaded audio or playback.'
  }

  async function readSavedRequest() {
    const data = await call(
      'GET', 'space/requests/' + encodeURIComponent(requestId)
    )
    if (data.ok !== true || data.requestId !== requestId ||
        !['waiting_connection', 'resolving', 'submitting',
          'recording', 'completed'].includes(data.state)) {
      throw new Error('Saved request status not confirmed')
    }
    return data
  }

  function showSavedRequest(data) {
    if (data.state === 'recording') {
      showJob(data.jobId)
    } else if (data.state === 'waiting_connection') {
      status.textContent =
        'Recording request is saved. Connect X, then use Resume saved recording request.'
    } else if (data.state === 'submitting') {
      status.textContent =
        'Recording start has an uncertain outcome. Do not send the Space again. ' +
        'Check /process; this request needs reconciliation before another start.'
    } else if (data.state === 'resolving') {
      status.textContent =
        'Saved request is being resolved or needs recovery after an interruption. ' +
        'No additional start was submitted.'
    } else {
      status.textContent = 'This saved request is already completed.'
    }
  }

  async function checkSavedRequest() {
    if (!requestId || requestBusy || busy) return
    requestBusy = true
    try {
      showSavedRequest(await readSavedRequest())
    } catch {
      status.textContent =
        'Saved request status could not be confirmed. No recording start was submitted.'
    } finally {
      requestBusy = false
    }
  }

  async function resumeSavedRequest() {
    if (!requestId || current?.status !== 'active' || requestBusy) return
    requestBusy = true
    status.textContent = 'Checking saved recording request…'
    try {
      const saved = await readSavedRequest()
      if (saved.state !== 'waiting_connection') {
        showSavedRequest(saved)
        return
      }
      status.textContent = 'Resuming saved recording request…'
      const data = await call(
        'POST',
        'space/requests/' + encodeURIComponent(requestId) + '/resume',
        { connectionId: current.id }
      )
      if (data.ok !== true || data.requestId !== requestId) {
        throw new Error('Recording retry not confirmed')
      }
      showJob(data.jobId)
    } catch {
      status.textContent =
        'Recording retry was not confirmed. Your saved connection has not been ' +
        'marked invalid by this screen. Check saved request status before retrying; ' +
        'do not send the Space again.'
    } finally {
      requestBusy = false
    }
  }

  function display() {
    panel.replaceChildren()
    status.textContent = !current ? 'Not connected'
      : current.status === 'active' ? 'Connected'
      : 'Reconnect required'

    if (current) {
      const account = document.createElement('p')
      account.textContent = current.x_handle
        ? '@' + current.x_handle : 'Saved X account'
      panel.append(account)
    }

    const note = document.createElement('p')
    note.textContent =
      'This installation uses session import, not X password sign-in. ' +
      'Never enter your X password. Submit session material only here, ' +
      'not in Telegram messages. It is sent to the recorder for validation ' +
      'and encrypted storage; it is not saved in browser storage.'
    panel.append(note)

    const form = document.createElement('form')
    form.autocomplete = 'off'
    const label = document.createElement('label')
    label.textContent = 'Authenticated X session'
    const input = document.createElement('input')
    input.type = 'password'
    input.autocomplete = 'off'
    input.spellcheck = false
    input.required = true
    input.placeholder = 'auth_token=…; ct0=…'
    input.setAttribute('autocapitalize', 'off')
    label.append(input)
    form.append(label)

    const consentLabel = document.createElement('label')
    const consent = document.createElement('input')
    consent.type = 'checkbox'
    consent.required = true
    consentLabel.append(consent, document.createTextNode(
      ' I own or am authorized to use this X account, and authorize ' +
      'the recorder to use its access for recordings I request.'
    ))
    form.append(consentLabel)

    const submit = document.createElement('button')
    submit.type = 'submit'
    submit.textContent = current ? 'Reconnect X session' : 'Save X session'
    form.append(submit)

    form.onsubmit = async event => {
      event.preventDefault()
      if (busy || requestBusy || !consent.checked || !input.value.trim()) return
      busy = true
      submit.disabled = true
      let session = input.value.trim()
      input.value = ''
      const path = current
        ? 'x-connections/' + encodeURIComponent(current.id) + '/reconnect'
        : 'x-connections/complete'
      status.textContent = 'Validating session…'
      try {
        const pending = call('POST', path, {
          auth_type: 'session', cookie: session, consent: true,
        })
        session = ''
        const data = await pending
        if (data.ok !== true || !data.connection) {
          throw new Error('Session connection was not confirmed.')
        }
        current = data.connection
        display()
        await resumeSavedRequest()
      } catch {
        status.textContent =
          'Connection was not confirmed. Refresh status before retrying. ' +
          'The session may be invalid, or validation may be unavailable.'
      } finally {
        session = ''
        busy = false
        submit.disabled = false
      }
    }
    panel.append(form)

    button('Refresh connection status', async () => {
      if (busy || requestBusy) return
      await load()
    })

    if (current) {
      button('Disconnect X', async () => {
        if (busy || requestBusy) return
        busy = true
        try {
          const data = await call(
            'DELETE', 'x-connections/' + encodeURIComponent(current.id)
          )
          if (data.ok !== true) throw new Error('Disconnect not confirmed')
          current = null
          display()
        } catch {
          status.textContent = 'Disconnect was not confirmed. Refresh status.'
        } finally {
          busy = false
        }
      })
    }

    if (requestId) {
      button('Check saved request status', checkSavedRequest)
      if (current?.status === 'active') {
        button('Resume saved recording request', async () => {
          if (busy || requestBusy) return
          await resumeSavedRequest()
        })
      }
    }

    const limitation = document.createElement('p')
    limitation.textContent =
      'Connected means the session was accepted at its last validation. ' +
      'A recording job acknowledgement is not proof of downloaded or playable audio.'
    panel.append(limitation)
  }

  async function load() {
    if (busy || requestBusy) return
    busy = true
    status.textContent = 'Checking connection…'
    try {
      const data = await call('GET', 'x-connections')
      if (!Array.isArray(data)) throw new Error('Invalid response')
      const connections = data.filter(row =>
        row && /^[A-Za-z0-9_-]{1,100}$/.test(row.id || '')
      )
      if (connections.length > 1) {
        panel.replaceChildren()
        current = null
        status.textContent =
          'Multiple saved connections found. Account selection must be resolved before continuing.'
        return
      }
      current = connections[0] || null
      display()
    } catch {
      panel.replaceChildren()
      status.textContent =
        'Connection status could not be loaded. No session was submitted.'
      button('Retry status check', load)
    } finally {
      busy = false
    }
  }

  await load()
})().catch(() => {
  const status = document.querySelector('[role="status"]')
  if (status) status.textContent = 'X account setup could not initialize.'
})

