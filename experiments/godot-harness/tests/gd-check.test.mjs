import assert from 'node:assert/strict'
import test from 'node:test'
import { MessageReader, SEVERITY, collectScripts, decodeUriPath, encodeFrame, uriKey } from '../controller/gd-check.mjs'

/**
 * The parts of `controller/gd-check.mjs` that can go wrong without Godot
 * running: the `Content-Length` framing (TCP splits and merges messages) and
 * the URI folding (Godot writes `file:///C%3A/...`, this client writes
 * `file:///C:/...`). Both produced real bugs before these tests existed.
 */

test('encodeFrame writes a Content-Length header and a JSON body', () => {
  const frame = encodeFrame({ jsonrpc: '2.0', id: 7, method: 'initialize', params: {} })
  const text = frame.toString('utf8')
  const headerEnd = text.indexOf('\r\n\r\n')
  assert.ok(headerEnd > 0)
  const header = text.slice(0, headerEnd)
  const body = text.slice(headerEnd + 4)
  assert.equal(header, `Content-Length: ${Buffer.byteLength(body)}`)
  assert.deepEqual(JSON.parse(body), { jsonrpc: '2.0', id: 7, method: 'initialize', params: {} })
})

test('MessageReader reassembles a message split across chunks', () => {
  const frame = encodeFrame({ jsonrpc: '2.0', method: 'ready' })
  const reader = new MessageReader()
  const messages = []
  // One byte at a time is the worst case TCP can actually deliver.
  for (const byte of frame) messages.push(...reader.push(Buffer.from([byte])))
  assert.equal(messages.length, 1)
  assert.equal(messages[0].method, 'ready')
})

test('MessageReader returns several messages delivered in one chunk', () => {
  const batch = Buffer.concat([
    encodeFrame({ jsonrpc: '2.0', id: 1, result: { ok: true } }),
    encodeFrame({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: {} }),
  ])
  const messages = new MessageReader().push(batch)
  assert.equal(messages.length, 2)
  assert.equal(messages[0].id, 1)
  assert.equal(messages[1].method, 'textDocument/publishDiagnostics')
})

test('MessageReader keeps a partial tail for the next chunk', () => {
  const frame = encodeFrame({ jsonrpc: '2.0', method: 'first' })
  const reader = new MessageReader()
  const cut = frame.length - 5
  assert.deepEqual(reader.push(frame.subarray(0, cut)), [])
  const rest = reader.push(frame.subarray(cut))
  assert.equal(rest.length, 1)
  assert.equal(rest[0].method, 'first')
})

test('a frame without Content-Length is rejected instead of desynchronising the stream', () => {
  const reader = new MessageReader()
  assert.throws(() => reader.push(Buffer.from('X-Nope: 1\r\n\r\n{}', 'ascii')), /Content-Length/)
})

test('uriKey folds percent-encoded and plain drive letters to the same key', () => {
  assert.equal(
    uriKey('file:///C%3A/Users/<user>/project/voxel/scripts/voxel_data.gd'),
    uriKey('file:///C:/Users/<user>/project/voxel/scripts/voxel_data.gd'),
  )
})

test('uriKey ignores case and separators', () => {
  assert.equal(
    uriKey('file:///c%3a/Users/<USER>/Project/A.gd'),
    uriKey('C:\\users\\<user>\\project\\a.gd'),
  )
})

test('decodeUriPath keeps the original case and normalises separators', () => {
  assert.equal(
    decodeUriPath('file:///C%3A/Users/<User>/Voxel/Scripts/A.gd'),
    'C:/Users/<User>/Voxel/Scripts/A.gd',
  )
})

test('decodeUriPath leaves a literal percent alone instead of throwing', () => {
  assert.equal(decodeUriPath('file:///C:/tmp/100%.gd'), 'C:/tmp/100%.gd')
})

test('severity names match the LSP numeric levels', () => {
  assert.deepEqual(SEVERITY, { 1: 'error', 2: 'warning', 3: 'information', 4: 'hint' })
})

test('collectScripts finds the voxel scripts and skips engine caches', () => {
  const files = collectScripts(['voxel/scripts'])
  assert.ok(files.length >= 5)
  assert.ok(files.every((file) => file.endsWith('.gd')))
  assert.ok(files.every((file) => !file.includes('.godot')))
  assert.ok(files.some((file) => file.endsWith('voxel_data.gd')))
})

test('collectScripts rejects a path that does not exist', () => {
  assert.throws(() => collectScripts(['voxel/does-not-exist']), /No such script path/)
})
