const { test } = require('node:test')
const assert = require('node:assert/strict')
const { relayKeyMatches } = require('../middleware/verify-relay')

function request(value) {
  return {
    get(name) {
      if (name.toLowerCase() === 'x-recorder-relay-key') return value
      return undefined
    },
  }
}

test('relay key match is exact and fail-closed', () => {
  assert.equal(relayKeyMatches(request(''), 'secret'), false)
  assert.equal(relayKeyMatches(request('secret'), ''), false)
  assert.equal(relayKeyMatches(request('secret'), undefined), false)
  assert.equal(relayKeyMatches(request('secret-extra'), 'secret'), false)
  assert.equal(relayKeyMatches(request('secre'), 'secret'), false)
  assert.equal(relayKeyMatches(request('Secret'), 'secret'), false)
  assert.equal(relayKeyMatches(request('secret'), 'secret'), true)
})
