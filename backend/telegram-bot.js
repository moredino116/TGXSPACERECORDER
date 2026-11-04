// Telegram control surface for the local recorder.
// Links point at TELEGRAM_PUBLIC_BASE_URL so playback stays on this backend
// and never goes through Telegram's upload limit.

const http = require('http')
const https = require('https')
const { createTelegramWorkflow, completionNotice } = require('./lib/telegram-workflow')

function parseSpaceId(input) {
  if (!input) return null
  const text = String(input).trim()
  const match = text.match(/(?:spaces|broadcasts)\/([A-Za-z0-9]+)/)
  if (match) return match[1]
  if (/^[A-Za-z0-9]{10,}$/.test(text)) return text
  return null
}

function commandOf(text) {
  const match = String(text || '').trim().match(/^\/([A-Za-z0-9_]+)(?:@\w+)?(?:\s|$)/)
  return match ? match[1].toLowerCase() : null
}

function extractRecordInput(text) {
  // Markdown Space input v1
  const trimmed = String(text || '').trim()
  const command = trimmed.match(/^\/record(?:@\w+)?(?:\s+([\s\S]+))?$/i)
  const body = (command ? command[1] || '' : trimmed).trim()

  function urls(value) {
    return String(value).match(/https?:\/\/[^\s<>"'\[\]()]+/gi) || []
  }
  function reference(value) {
    try {
      const cleaned = String(value).replace(/[),.;>]+$/, '')
      const id = parseSpaceId(cleaned)
      return id ? { id: String(id), url: cleaned } : null
    } catch {
      return null
    }
  }

  let conflict = false
  const normalized = body.replace(
    /\[([^\]\r\n]*)\]\(\s*<?(https?:\/\/[^\s)>]+)>?\s*\)/gi,
    (whole, label, destination) => {
      const target = reference(destination)
      if (target) {
        for (const visible of urls(label)) {
          const shown = reference(visible)
          if (shown && shown.id !== target.id) conflict = true
        }
      }
      // A Markdown destination determines the link target.
      // Do not separately treat a misleading URL label as recording input.
      return ' ' + destination + ' '
    }
  )
  if (conflict) return null

  const candidates = urls(normalized)
  if (candidates.length) {
    const unique = new Map()
    for (const candidate of candidates) {
      const found = reference(candidate)
      if (found && !unique.has(found.id)) unique.set(found.id, found.url)
    }
    return unique.size === 1 ? [...unique.values()][0] : null
  }
  if (/^[A-Za-z0-9]{10,}$/.test(body)) return body
  return null
}

function parseClock(token) {
  const parts = String(token).split(':')
  if (parts.length < 1 || parts.length > 3) return null
  if (parts.some((part) => !/^\d+(?:\.\d+)?$/.test(part))) return null
  const numbers = parts.map(Number)
  if (numbers.some((n) => !Number.isFinite(n))) return null
  if (numbers.length === 1) return numbers[0]
  if (numbers.length === 2) return numbers[0] * 60 + numbers[1]
  return numbers[0] * 3600 + numbers[1] * 60 + numbers[2]
}

function parseClipRange(text) {
  const match = String(text || '').trim().match(/^(\d+(?::\d+){0,2})\s*-\s*(\d+(?::\d+){0,2})$/)
  if (!match) return null
  const start = parseClock(match[1])
  const end = parseClock(match[2])
  if (start == null || end == null || !(end > start)) return null
  return { start_seconds: start, end_seconds: end }
}

function publicUrl(base, pathname) {
  const root = String(base || '').replace(/\/+$/, '')
  const path = pathname.startsWith('/') ? pathname : `/${pathname}`

  // Signed playback links v1
  const signedPlaybackPath = path.split('?')[0]
  const signedPlaybackAllowed = /^\/api\/space\/(?:file|preview)\/[A-Za-z0-9_-]+$/.test(signedPlaybackPath)
    || /^\/api\/space\/clip\/[A-Za-z0-9_-]+\/file$/.test(signedPlaybackPath)
  if (signedPlaybackAllowed) {
    const signedKey = process.env.RECORDER_RELAY_KEY
    if (!signedKey) throw new Error('RECORDER_RELAY_KEY missing from bot environment')
    const signedExpiry = String(Math.floor(Date.now() / 1000) + 86400)
    const signedValue = require('crypto').createHmac('sha256', signedKey)
      .update(signedPlaybackPath + '\n' + signedExpiry).digest('hex')
    return root + path + (path.includes('?') ? '&' : '?')
      + 'expires=' + signedExpiry + '&signature=' + signedValue
  }
  return root + path

}

function formatClock(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function clipLabel(title) {
  const clean = String(title || 'Space').replace(/\s+/g, ' ').trim().slice(0, 80)
  return clean || 'Space'
}

function defaultRequest(base, method, pathname, body, ownerHeaders = {}) {
  const target = new URL(publicUrl(base, pathname))
  const payload = body == null ? null : Buffer.from(JSON.stringify(body))
  const lib = target.protocol === 'https:' ? https : http
  return new Promise((resolve, reject) => {
    const req = lib.request(
      target,
      {
        method,
        headers: {
          ...ownerHeaders,
          ...(payload
            ? { 'Content-Type': 'application/json', 'Content-Length': payload.length }
            : {}),
        },
      },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let json = null
          if (text) {
            try {
              json = JSON.parse(text)
            } catch {
              json = { error: text.slice(0, 300) }
            }
          }
          resolve({ status: res.statusCode || 0, json })
        })
      }
    )
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

function allowedUser(fromId, allowList) {
  if (!allowList.length) return true
  return allowList.includes(String(fromId))
}

function createRecorderBot({
  token,
  publicBaseUrl,
  miniAppBaseUrl,
  backendBaseUrl,
  request,
  relayKey = process.env.RECORDER_RELAY_KEY,
  Bot,
  polling = false,
  trackSavedRequests = false,
  allowedUserIds = [],
}) {
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is required')
  if (!publicBaseUrl) throw new Error('TELEGRAM_PUBLIC_BASE_URL is required')
  if (!Bot) throw new Error('A Telegram Bot implementation is required')

  const publicBase = String(publicBaseUrl).replace(/\/+$/, '')
  // Separate mini-app and recorder origins v1
  const miniAppBase = String(miniAppBaseUrl || publicBaseUrl).replace(/\/+$/, '')
  const miniAppTarget = new URL(miniAppBase)
  if (miniAppTarget.protocol !== 'https:' ||
      miniAppTarget.username || miniAppTarget.password ||
      miniAppTarget.search || miniAppTarget.hash) {
    throw new Error('Mini-app base must be an HTTPS URL without credentials or query parameters')
  }
  const apiBase = String(backendBaseUrl || 'http://127.0.0.1:3001').replace(/\/+$/, '')
  // Telegram owner forwarding v1
  const call = (method, pathname, body, ownerId) => {
    const headers = {}
    if (ownerId !== undefined && ownerId !== null) {
      const id = String(ownerId)
      if (!/^[1-9][0-9]{0,19}$/.test(id)) {
        throw new Error('Invalid Telegram owner identity')
      }
      if (!relayKey) {
        throw new Error('Recorder relay authentication is not configured')
      }
      headers['x-relay-key'] = relayKey
      headers['x-relay-user'] = id
    }
    return request
      ? request(method, pathname, body, { headers })
      : defaultRequest(apiBase, method, pathname, body, headers)
  }
  const allowList = allowedUserIds.map(String)
  const bot = new Bot(token, { polling })
  const active = new Map()
  const monitors = new Map()
  const awaitingClip = new Map()
  const pendingWatch = new Map()
  const { archiveUnconfirmed } = require('./lib/capture-result')
  const workflow = createTelegramWorkflow(miniAppBase)
  const savedRequestTracker = trackSavedRequests
    ? require('./lib/telegram-saved-request-tracker').createSavedRequestTracker({
        call, active, send, fileUrl, clipLabel, ownerIds: allowList,
      })
    : null

  function listenUrl(id) {
    return publicUrl(publicBase, `/api/space/preview/${id}`)
  }
  function fileUrl(id) {
    return publicUrl(publicBase, `/api/space/file/${id}`)
  }
  function clipUrl(id) {
    return publicUrl(publicBase, `/api/space/clip/${id}/file?play=1`)
  }
  function manageButton(kind, id, privateChat, label) {
    if (!['space', 'clip'].includes(kind) || !/^[A-Za-z0-9_-]{1,40}$/.test(id || '')) return null
    const url = new URL(miniAppBase + '/')
    url.searchParams.set('manage', kind)
    url.searchParams.set('id', id)
    return privateChat
      ? { text: label, web_app: { url: url.href } }
      : { text: label, url: url.href }
  }
  function recordingKeyboard(id, privateChat = true) {
    return {
      inline_keyboard: [[
        manageButton('space', id, privateChat, 'Listen so far'),
        { text: 'Stop & save', callback_data: `s:${id}` },
        { text: 'Delete', callback_data: `dk:space:${id}` },
      ]],
    }
  }

  async function send(chatId, text, extra) {
    return bot.sendMessage(chatId, text, extra)
  }

  async function guard(msgOrQuery) {
    const fromId = msgOrQuery.from?.id
    const chatId = msgOrQuery.chat?.id || msgOrQuery.message?.chat?.id
    if (allowedUser(fromId, allowList)) return true
    if (chatId) await send(chatId, 'This bot is private.')
    return false
  }


  async function sendXConnection(chatId, privateChat, reason, requestId) {
    if (!privateChat) {
      return send(chatId,
        'For account-assisted recording, open a private chat with this bot and use /connectx. Never send session material in messages.')
    }
    const url = new URL(miniAppBase + '/')
    url.searchParams.set('connect', 'x')
    if (requestId) url.searchParams.set('request', requestId)
    return send(chatId,
      (reason ? reason + '\n\n' : '') +
      'Open secure session setup below. Never send cookies or passwords in Telegram messages. ' +
      (requestId
         ? 'Your Space request is saved. After connecting, resume that saved request in this screen. Do not submit the Space again.'
         : 'Connect your account here, then send the Space you want to record.'),
      { reply_markup: { inline_keyboard: [[{
        text: 'Connect or manage X session',
        web_app: { url: url.href },
      }]] } })
  }

  async function startFromInput(chatId, input, ownerId, { explicitRecord = false } = {}) {
    const ownerCall = (method, pathname, body) =>
      call(method, pathname, body, ownerId)
    const { resolveWithSavedSession } = require('./lib/telegram-x-fallback')
    const privateChat = String(chatId) === String(ownerId)
    const outcome = await resolveWithSavedSession({
      call: ownerCall, input, allowConnected: privateChat,
      forceConnectedAccount: explicitRecord,
    })
    const resolved = outcome.response
    const access = outcome.access
    const body = resolved.json || {}
    if (outcome.needsConnection) {
      if (!privateChat) return sendXConnection(chatId, false, body.reason)
      let saved
      try {
        saved = await ownerCall('POST', '/api/space/requests', {
          spaceId: parseSpaceId(input),
        })
      } catch {
        return send(chatId, 'Could not save the pending recording request. No new recording was submitted. Try again later.')
      }
      const requestId = saved.json?.requestId
      if (saved.status !== 200 || saved.json?.ok !== true ||
          typeof requestId !== 'string' ||
          !/^[A-Za-z0-9_-]{1,100}$/.test(requestId)) {
        return send(chatId, 'Could not confirm the saved recording request. No new recording was submitted.')
      }
      return sendXConnection(chatId, true, body.reason, requestId)
    }
    if (outcome.stop) {
      return send(chatId, body.reason || body.error || 'Account-assisted recording could not be confirmed.')
    }
    if (body.ok && body.m3u8) {
      const started = await ownerCall('POST', '/api/space/download', {
        ...access,
        m3u8: body.m3u8,
        name: body.title || 'Space',
        title: body.title || null,
        source: 'space',
        input,
        enhance: true,
      })
      const job = started.json || {}
      if (!job.id) {
        await send(chatId, job.error || 'Could not start the recording.')
        return
      }
      active.set(job.id, { id: job.id, chatId, ownerId: String(ownerId), title: body.title || 'Space' })
      await send(
        chatId,
        `Recording started.\n${clipLabel(body.title)}\n${body.live ? 'Live' : 'Replay'}`,
        { reply_markup: recordingKeyboard(job.id) }
      )
      return
    }
    if (parseSpaceId(input)) {
      const tokenId = Math.random().toString(36).slice(2, 8)
      pendingWatch.set(tokenId, { input, title: body.title || null, chatId, ownerId: String(ownerId), access })
      await send(
        chatId,
        `${body.reason || 'This Space is not reachable yet.'}\n\nWatch for it and record when audio is available?`,
        { reply_markup: { inline_keyboard: [[{ text: 'Watch for it', callback_data: `w:${tokenId}` }]] } }
      )
      return
    }
    await send(chatId, body.reason || 'Paste an X Space link, or use /record <link>.')
  }

  async function sendStatus(chatId, privateChat = true) {
    if (savedRequestTracker) await savedRequestTracker.sync()
    const response = await call('GET', '/api/space/process')
    const body = response.json || {}
    const activeRows = response.status === 200 && body.ok === true && Array.isArray(body.active)
      ? body.active.filter(row => row && row.item_kind === 'space' && /^[A-Za-z0-9_-]{1,40}$/.test(row.id || ''))
      : []
    const watching = [...monitors.values()].filter((mon) => mon.chatId === chatId && !mon.jobId)
    if (!activeRows.length && !watching.length) {
      await send(chatId, 'No active recordings.')
      return
    }
    for (const mon of watching) {
      await send(chatId, `Watching.\n${clipLabel(mon.title)}\n${mon.lastReason || 'Waiting for the Space.'}`)
    }
    for (const row of activeRows) {
      await send(chatId,
        `${clipLabel(row.title)}\n${row.state || 'active'} · ${formatClock(row.duration_seconds || 0)} captured`,
        { reply_markup: recordingKeyboard(row.id, privateChat) })
    }
  }

  // Telegram Restore helper wiring v1
  const { sendRestore, handleRestoreAction } =
    require('./lib/telegram-restore').createTelegramRestore({
      call, send, clipLabel, formatClock,
    })

  // Telegram item controls v2
  function itemKeyboard(kind, id, privateChat, includeArchive = false) {
    if (!['space', 'clip'].includes(kind) || typeof id !== 'string' ||
        !/^[A-Za-z0-9_-]{1,40}$/.test(id)) return null
    const manage = manageButton(kind, id, privateChat, 'Manage')
    if (!manage) return null
    const buttons = [manage, { text: 'Delete', callback_data: `dk:${kind}:${id}` }]
    if (includeArchive) buttons.push({ text: 'Archive', callback_data: `ak:${kind}:${id}` })
    return { reply_markup: { inline_keyboard: [buttons] } }
  }

  async function sendArchive(chatId, privateChat) {
    const listed = await call('GET', '/api/space/archive')
    const rows = Array.isArray(listed.json) ? listed.json : []
    if (!rows.length) {
      await send(chatId, listed.json?.error || 'Archive is empty.')
      return
    }
    for (const row of rows.slice(0, 8)) {
      const kind = row.item_kind || 'space'
      const keyboard = itemKeyboard(kind, row.id, privateChat)
      if (!keyboard) {
        await send(chatId, 'An item could not be displayed: unsupported kind or ID.')
        continue
      }
      const title = clipLabel(row.title || row.name)
      await send(chatId,
        `${title}\n${row.kind || 'audio'} · ` +
        `${formatClock(row.duration_seconds)} · ${formatBytes(row.size_bytes)}`,
        keyboard)
    }
  }

  async function sendClips(chatId, privateChat) {
    const listed = await call('GET', '/api/space/clips')
    const rows = Array.isArray(listed.json) ? listed.json : []
    if (!rows.length) {
      await send(chatId, listed.json?.error || 'No clips yet.')
      return
    }
    for (const row of rows.slice(0, 8)) {
      const keyboard = itemKeyboard('clip', row.id, privateChat)
      if (!keyboard) {
        await send(chatId, 'An item could not be displayed: unsupported kind or ID.')
        continue
      }
      const parent = row.parent_title || row.parent_name || 'recording'
      await send(chatId,
        `${clipLabel(row.title)}\nFrom ${clipLabel(parent)} · ` +
        `${formatClock(row.duration_seconds)}`,
        keyboard)
    }
  }

  // Process collection Telegram integration v1
  async function sendProcess(chatId, privateChat) {
    const response = await call('GET', '/api/space/process')
    const body = response.json || {}
    if (response.status !== 200 || body.ok !== true ||
        !Array.isArray(body.active) || !Array.isArray(body.completed)) {
      return send(chatId, body.error || 'Could not load the process collection.')
    }

    const rows = body.completed.filter(row => !row.archived_at && !row.deleted_at)
    if (!rows.length) return send(chatId, 'No completed unarchived recordings in Process.')

    await send(chatId,
      `Process: ${rows.length} completed, unarchived recordings.`)

    for (const row of rows) {
      const keyboard = itemKeyboard(row.item_kind, row.id, privateChat, true)
      if (row.item_kind !== 'space' || !keyboard) {
        await send(chatId, 'An item could not be displayed: unsupported kind or ID.')
        continue
      }
      await send(chatId,
        `${clipLabel(row.title)}\n${row.state} · ` +
        `${formatClock(row.duration_seconds || 0)}` +
        (row.archived_at ? '\nArchived; capture remains active.' : ''),
        keyboard)
    }
  }

  async function onMessage(msg) {
    if (!msg?.chat) return
    if (!(await guard(msg))) return
    const { normalizeTelegramMessage } = require('./lib/telegram-message-input')
    msg = normalizeTelegramMessage(msg)
    if (msg.recorderInputAmbiguous) {
      return send(msg.chat.id, 'Send one X Space link per message. No recording started.')
    }
    if (!msg.text) return
    const text = msg.text.trim()
    const command = commandOf(text)
    const chatId = msg.chat.id
    if (command === 'connectx') {
      return sendXConnection(chatId, msg.chat.type === 'private')
    }
    if (command === 'start' || command === 'help') {
      await send(chatId, 'Paste an X Space link, or use /record <link>.\n/app · /process · /status · /stop · /archive · /clips · /restore · /cancel')
      return
    }
    // Bot controls patch A
    if (command === 'app') {
      return send(chatId, 'Open the player and use the scissors button to clip.', {
        reply_markup: { inline_keyboard: [[{
          text: 'Player and clip editor',
          web_app: { url: miniAppBase + '/' }
        }]] }
      })
    }
    if (command === 'cancel') {
      awaitingClip.delete(chatId)
      return send(chatId, 'Clip entry cancelled. Recordings unchanged.')
    }
    if (command === 'stop') {
      const id = text.trim().split(/\s+/)[1]
      const mine = [...active.values()].filter(j => j.chatId === chatId)
      const job = id ? mine.find(j => j.id === id)
        : mine.length === 1 ? mine[0] : null
      if (!job) return send(chatId, mine.length
        ? mine.map(j => '/stop ' + j.id).join('\n')
        : 'No active recordings tracked by this bot.')
      const r = await call('POST', `/api/space/stop/${job.id}`)
      return send(chatId, r.json?.ok
        ? 'Stopping and saving. Wait for Saved.'
        : r.json?.error || 'Could not stop.')
    }
    if (command === 'process') return sendProcess(chatId, msg.chat.type === 'private')
    if (command === 'status') return sendStatus(chatId, msg.chat.type === 'private')
    if (command === 'restore') return sendRestore(chatId)
    if (command === 'archive') return sendArchive(chatId, msg.chat?.type === 'private')
    if (command === 'clips') return sendClips(chatId, msg.chat?.type === 'private')
    if (command === 'record') {
      const input = extractRecordInput(text)
      if (!input) {
        await send(chatId, 'Usage: /record <X Space link>')
        return
      }
      return startFromInput(chatId, input, msg.from.id, { explicitRecord: true })
    }
    if (command) {
      await send(chatId, 'Unknown command. Use /record, /process, /status, /archive, /clips, or /restore.')
      return
    }
    const range = parseClipRange(text)
    if (range && awaitingClip.has(chatId)) {
      const pending = awaitingClip.get(chatId)
      awaitingClip.delete(chatId)
      const created = await call('POST', `/api/space/recordings/${pending.id}/clips`, {
        title: `${clipLabel(pending.title)} clip`,
        start_seconds: range.start_seconds,
        end_seconds: range.end_seconds,
        enhance: true,
      })
      const clip = created.json || {}
      if (!clip.id) {
        await send(chatId, clip.error || 'Could not create that clip.')
        return
      }
      await send(chatId, `Clip ready.\n${clipUrl(clip.id)}`)
      return
    }
    const input = extractRecordInput(text)
    if (input) return startFromInput(chatId, input, msg.from.id)
    if (awaitingClip.has(chatId)) {
      await send(chatId, 'Send the clip range as 1:30-4:00')
      return
    }
    await send(chatId, 'Paste an X Space link, or use /record <link>.')
  }

  const itemDeletionInFlight = new Set()

  async function deleteItem(chatId, kind, itemId) {
    if (!['space', 'clip'].includes(kind) ||
        !/^[A-Za-z0-9_-]{1,40}$/.test(itemId || '')) {
      return send(chatId, 'Invalid Delete action.')
    }
    const key = JSON.stringify([chatId, kind, itemId])
    if (itemDeletionInFlight.has(key)) return
    itemDeletionInFlight.add(key)
    const unverified =
      'Deletion hold could not be verified. Check /restore before retrying.'
    try {
      const endpoint = kind === 'clip'
        ? `/api/space/clips/${itemId}`
        : `/api/space/archive/${itemId}`
      const response = await call('DELETE', endpoint)
      const body = response.json || {}
      if (response.status !== 200 || body.ok !== true ||
          typeof body.purge_after !== 'string' ||
          !Number.isFinite(Date.parse(body.purge_after))) {
        return send(chatId, unverified)
      }
      return send(chatId,
        'Deletion scheduled with a two-hour hold.\n' +
        `Restore deadline: ${body.purge_after}\nUse /restore to recover it.`)
    } catch {
      return send(chatId, unverified)
    } finally {
      itemDeletionInFlight.delete(key)
    }
  }

  async function onCallback(query) {
    if (!query?.data) return
    if (bot.answerCallbackQuery) await bot.answerCallbackQuery(query.id)
    if (!(await guard(query))) return
    const chatId = query.message?.chat?.id
    if (!chatId) return
    if (String(query.data).startsWith('rt:')) {
      return handleRestoreAction(chatId, query.data)
    }

    if (/^(dk|yk):/.test(String(query.data))) {
      const target = String(query.data).match(
        /^(dk|yk):(space|clip):([A-Za-z0-9_-]{1,40})$/
      )
      if (!target) return send(chatId, 'Invalid Delete action.')
      const [, , kind, itemId] = target
      return deleteItem(chatId, kind, itemId)
    }

    if (String(query.data).startsWith('ak:')) {
      const target = String(query.data).match(
        /^ak:(space|clip):([A-Za-z0-9_-]{1,40})$/
      )
      if (!target) return send(chatId, 'Invalid Archive action.')
      const [, kind, itemId] = target
      const endpoint = kind === 'space'
        ? `/api/space/recordings/${itemId}/archive`
        : `/api/retention/items/clip/${itemId}/archive`
      const response = await call('POST', endpoint)
      const body = response.json || {}
      if (response.status !== 200 || body.ok !== true ||
          !body.item?.archived_at) {
        return send(chatId, body.error || 'Archive could not be verified.')
      }
      return send(chatId, body.item.deleted_at
        ? 'Archived, but still pending deletion. Use /restore separately.'
        : 'Archived. Active capture has not been stopped.')
    }

    const [action, id] = String(query.data).split(':')
    if (action === 'w') {
      const pending = pendingWatch.get(id)
      if (!pending) {
        await send(chatId, 'That watch request expired. Send the link again.')
        return
      }
      if (pending.ownerId !== String(query.from?.id) ||
          pending.chatId !== chatId) {
        await send(chatId, 'That watch request belongs to another user or chat.')
        return
      }
      pendingWatch.delete(id)
      const started = await call('POST', '/api/space/monitor', {
        ...pending.access,
        input: pending.input,
        name: pending.title || 'Space',
        enhance: true,
      }, query.from.id)
      const mon = started.json || {}
      if (!mon.id) {
        await send(chatId, mon.error || 'Could not start watching.')
        return
      }
      monitors.set(mon.id, { id: mon.id, chatId, ownerId: pending.ownerId, input: pending.input, title: pending.title, jobId: null })
      await send(chatId, `Watching ${clipLabel(pending.title)}.\nI'll start recording when the Space is reachable.`)
      return
    }
    if (action === 's') {
      const stopped = await call('POST', `/api/space/stop/${id}`)
      const body = stopped.json || {}
      await send(chatId, body.ok ? 'Stopping and saving what has been captured.' : (body.error || 'Could not stop that recording.'))
      return
    }
    if (action === 'c') {
      awaitingClip.set(chatId, { id, title: 'Clip' })
      await send(chatId, 'Send the clip range as 1:30-4:00')
      return
    }
    if (action === 'd' || action === 'y') {
      const target = String(query.data).match(
        /^[dy]:([A-Za-z0-9_-]{1,40})$/
      )
      if (!target) return send(chatId, 'Invalid Delete action.')
      return deleteItem(chatId, 'space', target[1])
    }
    if (action === 'n') {
      await send(chatId, 'Kept.')
    }
  }

  async function pollOnce() {
    if (savedRequestTracker) await savedRequestTracker.poll()
    for (const mon of [...monitors.values()]) {
      const status = await call('GET', `/api/space/monitor/${mon.id}`)
      const row = status.json || {}
      if (row.lastReason) mon.lastReason = row.lastReason
      if (row.title) mon.title = row.title
      if (row.state === 'recording' && row.jobId && !mon.jobId) {
        mon.jobId = row.jobId
        active.set(row.jobId, { id: row.jobId, chatId: mon.chatId, title: row.title || mon.title || 'Space' })
        await send(mon.chatId, `Recording started.\n${clipLabel(row.title || mon.title)}`, {
          reply_markup: recordingKeyboard(row.jobId),
        })
      }
      if (row.state === 'error' || row.state === 'cancelled' || row.state === 'ended') {
        monitors.delete(mon.id)
        if (row.state === 'error') await send(mon.chatId, row.lastReason || 'Stopped watching.')
      }
    }
    for (const job of [...active.values()]) {
      if (job.savedRequestId) continue
      const status = await call('GET', `/api/space/status/${job.id}`)
      const row = status.json || {}
      if (status.status === 404) {
        active.delete(job.id)
        continue
      }
      if (row.state === 'ready') {
        if (archiveUnconfirmed(row)) {
          if (!job.archiveNoticeSent) {
            await send(job.chatId,
              'Audio file retained, but archive indexing is not confirmed. ' +
              'Do not submit another recording. Job: ' + job.id)
            job.archiveNoticeSent = true
          }
          continue
        }
        active.delete(job.id)
        await send(job.chatId, completionNotice(row, clipLabel(row.name || job.title)), {
          reply_markup: workflow.completionKeyboard(job.id, true),
        })
      } else if (row.state === 'error') {
        active.delete(job.id)
        await send(job.chatId, row.error || 'Recording failed.')
      }
    }
  }

  bot.on('message', (msg) => onMessage(msg))
  bot.on('callback_query', (query) => onCallback(query))

  return { bot, pollOnce, active, monitors, awaitingClip, onMessage, onCallback }
}

function readAllowList(raw = process.env.TELEGRAM_ALLOWED_USER_IDS || '') {
  return String(raw)
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
}

function launchError({ token, publicBaseUrl, allowedUserIds }) {
  if (!token) return 'TELEGRAM_BOT_TOKEN is required. Set it in the terminal. Do not paste it into chat.'
  if (!publicBaseUrl) return 'TELEGRAM_PUBLIC_BASE_URL is required. Use the HTTPS address your phone can open.'
  let url
  try {
    url = new URL(publicBaseUrl)
  } catch {
    return 'TELEGRAM_PUBLIC_BASE_URL must be a full https:// address.'
  }
  const host = url.hostname.toLowerCase()
  const privateHost =
    host === 'localhost' ||
    host.endsWith('.local') ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host === '[::1]' ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
  if (url.protocol !== 'https:' || privateHost) {
    return 'TELEGRAM_PUBLIC_BASE_URL must be a public https:// address. localhost and private IPs will not open from Telegram on your phone.'
  }
  if (!allowedUserIds.length || allowedUserIds.some((id) => !/^\d+$/.test(id))) {
    return 'TELEGRAM_ALLOWED_USER_IDS must be your numeric Telegram user ID. A @handle is not accepted.'
  }
  return null
}

// node-telegram-bot-api v2 is a different client from the old polling constructor.
// This adapter keeps the recorder logic on plain messages and callback queries.
function V2Bot(token) {
  const { Bot } = require('node-telegram-bot-api')
  this.inner = new Bot(token)
}

V2Bot.prototype.on = function on(event, fn) {
  if (event === 'message') {
    this.inner.on('message', (ctx) => {
      const message = ctx.message
      if (!message) return undefined
      return fn({ ...message, from: message.from || ctx.from, chat: message.chat })
    })
  }
  if (event === 'callback_query') {
    this.inner.on('callback_query', (ctx) => {
      const query = ctx.callbackQuery
      if (!query) return undefined
      return fn({
        id: query.id,
        data: query.data,
        from: query.from || ctx.from,
        message: query.message,
      })
    })
  }
  return undefined
}

V2Bot.prototype.sendMessage = function sendMessage(chatId, text, extra) {
  return this.inner.api.sendMessage({
    chat_id: chatId,
    text,
    reply_markup: extra && extra.reply_markup,
  })
}

V2Bot.prototype.answerCallbackQuery = function answerCallbackQuery(id) {
  return this.inner.api.answerCallbackQuery({ callback_query_id: id })
}

function main() {
  const token = process.env.TELEGRAM_BOT_TOKEN
  const publicBaseUrl = process.env.TELEGRAM_PUBLIC_BASE_URL
  const allowedUserIds = readAllowList()
  const error = launchError({ token, publicBaseUrl, allowedUserIds })
  if (error) {
    console.error(error)
    process.exit(1)
  }
  const { run } = require('node-telegram-bot-api/node')
  const port = Number(process.env.BACKEND_PORT || 3001)
  const recorder = createRecorderBot({
    token,
    publicBaseUrl,
    miniAppBaseUrl: process.env.TELEGRAM_MINI_APP_BASE_URL,
    backendBaseUrl: `http://127.0.0.1:${port}`,
    Bot: V2Bot,
    polling: true,
    trackSavedRequests: true,
    allowedUserIds,
  })
  const recorderPollTimer = setInterval(() => {
    recorder.pollOnce().catch((err) => console.error('[telegram] poll failed:', err?.message || err))
  }, 5000)
  console.log(`[telegram] bot polling; recorder API at http://127.0.0.1:${port}`)
  run(recorder.bot.inner).finally(() => clearInterval(recorderPollTimer)).catch((err) => {
    console.error('[telegram] polling stopped:', err?.message || err)
    process.exit(1)
  })
}

if (require.main === module) main()

module.exports = {
  parseSpaceId,
  parseClipRange,
  extractRecordInput,
  publicUrl,
  createRecorderBot,
  formatClock,
  launchError,
}

