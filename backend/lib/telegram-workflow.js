const { completionText } = require('./capture-result')

function createTelegramWorkflow(base) {
  const root = new URL(base)
  if (root.protocol !== 'https:' || root.username || root.password || root.search || root.hash) {
    throw new Error('Invalid Mini App origin')
  }
  function manageButton(kind, id, privateChat = true, label = 'Manage') {
    if (!['space', 'clip'].includes(kind) || !/^[A-Za-z0-9_-]{1,40}$/.test(id || '')) {
      throw new Error('Invalid selected item')
    }
    const url = new URL(root.href.replace(/\/+$/, '') + '/')
    url.searchParams.set('manage', kind)
    url.searchParams.set('id', id)
    return privateChat ? { text: label, web_app: { url: url.href } }
      : { text: label, url: url.href }
  }
  function recordingKeyboard(id, privateChat = true) {
    return { inline_keyboard: [[
      manageButton('space', id, privateChat, 'Listen so far'),
      { text: 'Stop & save', callback_data: `s:${id}` },
      { text: 'Delete', callback_data: `dk:space:${id}` },
    ]] }
  }
  function itemKeyboard(kind, id, privateChat, archive = false) {
    const buttons = [manageButton(kind, id, privateChat),
      { text: 'Delete', callback_data: `dk:${kind}:${id}` }]
    if (archive) buttons.push({ text: 'Archive', callback_data: `ak:${kind}:${id}` })
    return { reply_markup: { inline_keyboard: [buttons] } }
  }
  function completionKeyboard(id, privateChat = true) {
    return { inline_keyboard: [[manageButton('space', id, privateChat)]] }
  }
  return { recordingKeyboard, itemKeyboard, completionKeyboard }
}

function completionNotice(row, title) {
  const result = completionText(row)
  return result === 'Saved.' ? `Recording Confirmed: ${title}` : `${result}\n${title}`
}
module.exports = { createTelegramWorkflow, completionNotice }
