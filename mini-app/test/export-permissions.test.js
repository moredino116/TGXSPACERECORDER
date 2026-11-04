const test = require('node:test')
const assert = require('node:assert/strict')
const { allowed } = require('../lib/verify')
const id = 'e' + 'a'.repeat(32)

test('export relay permits only intended creation listing status and removal paths', () => {
  for (const [method, path] of [
    ['POST', 'space/exports'],
    ['GET', 'space/exports/source/clip/clip1'],
    ['GET', 'space/exports/source/space/recording1'],
    ['GET', 'space/exports/' + id],
    ['DELETE', 'space/exports/' + id],
  ]) assert.equal(allowed(method, path), true, method + ' ' + path)
})

test('export relay rejects file signing traversal and arbitrary export mutations', () => {
  for (const [method, path] of [
    ['GET', 'space/exports/' + id + '/file'],
    ['POST', 'space/exports/' + id + '/download'],
    ['POST', 'space/exports/' + id],
    ['PUT', 'space/exports/' + id],
    ['GET', 'space/exports/source/clip/../outside'],
    ['GET', 'space/exports/source/other/item'],
    ['DELETE', 'space/exports/not-an-export-id'],
    ['GET', 'space/exports/' + id + '/extra'],
  ]) assert.equal(allowed(method, path), false, method + ' ' + path)
})
