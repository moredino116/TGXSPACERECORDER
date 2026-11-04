function createTelegramRestore({ call, send, clipLabel, formatClock }) {
  async function sendRestore(chatId) {
    const r = await call('GET', '/api/retention/restore')
    const b = r.json || {}
    if (r.status !== 200 || !b.ok || !Array.isArray(b.items)) {
      return send(chatId, b.error || 'Could not load Restore.')
    }
    if (!b.items.length) {
      return send(chatId, 'No deleted Spaces or clips within the two-hour window.')
    }
    for (const item of b.items) {
      const kind = item.item_kind
      if (!['space', 'clip'].includes(kind)) continue
      if (!/^[A-Za-z0-9_-]{1,40}$/.test(item.id || '')) continue
      await send(chatId,
        clipLabel(item.title || item.id) + '\n' +
        (kind === 'space' ? 'Space' : 'Clip') + ' · ' + item.id + '\n' +
        'Remaining when listed: ' + formatClock(item.remaining_seconds),
        { reply_markup: { inline_keyboard: [[{
          text: 'Restore',
          callback_data: `rt:${kind}:${item.id}`,
        }]] } })
    }
  }

  async function handleRestoreAction(chatId, data) {
    const m = String(data).match(/^rt:(space|clip):([A-Za-z0-9_-]{1,40})$/)
    if (!m) return send(chatId, 'Invalid Restore action.')
    const r = await call('POST', `/api/retention/items/${m[1]}/${m[2]}/restore`)
    const b = r.json || {}
    return send(chatId, r.status === 200 && b.ok
      ? 'Restored. Recording is not restarted.'
      : b.error || 'Could not restore item.')
  }

  return { sendRestore, handleRestoreAction }
}
module.exports = { createTelegramRestore }
