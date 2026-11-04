const test = require('node:test')
const assert = require('node:assert/strict')
const { allowed } = require('../lib/verify')

test('relay permits only the intended saved-request status and resume paths', () => {
  assert.equal(allowed('GET', 'space/requests/pending_test'), true)
  assert.equal(allowed('POST', 'space/requests/pending_test/resume'), true)
})

test('relay does not expose request creation or arbitrary request mutations', () => {
  assert.equal(allowed('POST', 'space/requests'), false)
  assert.equal(allowed('DELETE', 'space/requests/pending_test'), false)
  assert.equal(allowed('POST', 'space/requests/pending_test'), false)
  assert.equal(allowed('GET', 'space/requests/pending_test/resume'), false)
})

test('saved-request permissions reject traversal and extra path segments', () => {
  assert.equal(allowed('GET', 'space/requests/../pending_test'), false)
  assert.equal(allowed('GET', 'space/requests/pending_test/extra'), false)
  assert.equal(allowed('POST', 'space/requests//resume'), false)
})

