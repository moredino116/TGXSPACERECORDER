const test = require('node:test')
const assert = require('node:assert/strict')
const { normalizeTelegramMessage } = require('../lib/telegram-message-input')
const { extractRecordInput } = require('../telegram-bot')

const url = 'https://x.com/i/spaces/1rxmqpPayldxy?s=20'
const entity = { type: 'text_link', url, offset: 0, length: 4 }
const parsed = msg => extractRecordInput(normalizeTelegramMessage(msg).text)

test('ordinary URL still parses through the existing parser', () => {
  assert.equal(parsed({ text: url }), url)
})

test('record command accepts a hidden link destination', () => {
  assert.equal(parsed({
    text: '/record Open',
    entities: [{ ...entity, offset: 8 }],
  }), url)
})

test('bare hidden link accepts its destination', () => {
  assert.equal(parsed({ text: 'Open', entities: [entity] }), url)
})

test('caption hidden link accepts its destination', () => {
  assert.equal(parsed({
    caption: 'Open', caption_entities: [entity],
  }), url)
})

test('invisible formatting and spaced record command are normalized', () => {
  assert.equal(parsed({
    text: '/ record ' + url.replace('/spaces/', '/spa\u200Bces/'),
  }), url)
})

test('other commands retain their original arguments', () => {
  const text = '/stop existing-job'
  assert.equal(normalizeTelegramMessage({
    text, entities: [entity],
  }).text, text)
})

test('external hidden destination does not become a recording input', () => {
  assert.equal(parsed({
    text: 'Open',
    entities: [{ ...entity, url: 'https://example.com/i/spaces/1234567890' }],
  }), null)
})

test('multiple distinct Spaces are flagged for handler rejection', () => {
  const result = normalizeTelegramMessage({
    text: url + '\nhttps://x.com/i/spaces/1qxoNYovYEzJv',
  })
  assert.equal(result.recorderInputAmbiguous, true)
})

