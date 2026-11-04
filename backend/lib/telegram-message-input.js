function clean(value) {
  return String(value || '').normalize('NFKC')
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g, '')
    .trim()
}

function asSpaceUrl(value) {
  try {
    const url = new URL(clean(value))
    const hosts = [
      'x.com', 'www.x.com', 'mobile.x.com',
      'twitter.com', 'www.twitter.com', 'mobile.twitter.com',
    ]
    if (url.protocol !== 'https:' || url.username || url.password ||
        !hosts.includes(url.hostname.toLowerCase())) return null
    const match = url.pathname.match(
      /^\/i\/(?:spaces|broadcasts)\/([A-Za-z0-9]{10,})\/?$/
    )
    return match ? { id: match[1], url: url.href } : null
  } catch {
    return null
  }
}

function normalizeTelegramMessage(message) {
  if (!message || typeof message !== 'object') return message

  let text = clean(
    typeof message.text === 'string' ? message.text :
    typeof message.caption === 'string' ? message.caption : ''
  ).replace(/^\/\s+record\b/i, '/record')

  const command = text.match(/^\/([A-Za-z0-9_]+)(?:@\w+)?(?:\s|$)/)
  if (command && command[1].toLowerCase() !== 'record') {
    return { ...message, text }
  }

  const candidates = []
  for (const match of text.matchAll(/https?:\/\/[^\s<>"`]+/gi)) {
    const found = asSpaceUrl(match[0].replace(/[\]),.;>]+$/, ''))
    if (found) candidates.push(found)
  }

  const entities = [
    ...(Array.isArray(message.entities) ? message.entities : []),
    ...(Array.isArray(message.caption_entities) ? message.caption_entities : []),
  ]
  for (const entity of entities) {
    if (entity?.type !== 'text_link' || typeof entity.url !== 'string') continue
    const found = asSpaceUrl(entity.url)
    if (found) candidates.push(found)
  }

  const unique = new Map(candidates.map(item => [item.id, item.url]))
  if (unique.size > 1) {
    return { ...message, text, recorderInputAmbiguous: true }
  }
  if (unique.size === 1) {
    text = (command ? '/record ' : '') + [...unique.values()][0]
  }
  return { ...message, text }
}

module.exports = { normalizeTelegramMessage }
