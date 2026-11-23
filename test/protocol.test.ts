import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  Op,
  ProtocolError,
  Reader,
  Writer,
  decodeClientMessage,
  encodeHello,
  encodePush,
  encodeSynced,
} from '../src/protocol.ts';

const limits = { maxRecordBytes: 1024, maxRecordsPerPush: 10 };

test('varint: Hin- und Rückweg', () => {
  const values = [0, 1, 127, 128, 300, 16_383, 16_384, 2 ** 32, Number.MAX_SAFE_INTEGER];
  const w = new Writer();
  for (const v of values) w.varint(v);
  const r = new Reader(w.finish());
  for (const v of values) assert.equal(r.varint(), v);
  assert.ok(r.done);
});

test('varint: kleine Zahlen brauchen ein Byte', () => {
  assert.equal(new Writer().varint(127).finish().length, 1);
  assert.equal(new Writer().varint(128).finish().length, 2);
});

test('HELLO und PUSH werden dekodiert', () => {
  const vault = Buffer.alloc(16, 7);
  const hello = decodeClientMessage(encodeHello(vault, 42), limits);
  assert.deepEqual(hello, { op: Op.hello, version: 1, vault, lastSeq: 42 });

  const records = [
    { key: Buffer.alloc(16, 1), data: Buffer.from('abc') },
    { key: Buffer.alloc(16, 2), data: Buffer.alloc(200, 9) },
  ];
  const push = decodeClientMessage(encodePush(5, records), limits);
  assert.deepEqual(push, { op: Op.push, reqId: 5, records });
});

test('Ungültige Nachrichten werden abgelehnt', () => {
  const vault = Buffer.alloc(16);
  const cases = [
    Buffer.from([]),
    Buffer.from([0x7f]),
    encodeHello(vault, 1).subarray(0, 10),
    Buffer.concat([encodeHello(vault, 1), Buffer.from([0])]),
    encodePush(1, []),
    encodePush(1, [{ key: vault, data: Buffer.alloc(2000) }]),
    encodePush(1, Array.from({ length: 11 }, () => ({ key: vault, data: Buffer.alloc(1) }))),
  ];
  for (const c of cases) {
    assert.throws(() => decodeClientMessage(c, limits), ProtocolError);
  }
});

test('SYNCED enthält die Uhrzeit des Servers', () => {
  const r = new Reader(encodeSynced(3, 1_790_000_000_000));
  assert.equal(r.u8(), Op.synced);
  assert.equal(r.varint(), 3);
  assert.equal(r.varint(), 1_790_000_000_000);
  assert.ok(r.done);

  const now = new Reader(encodeSynced(0));
  now.u8();
  now.varint();
  assert.ok(Math.abs(now.varint() - Date.now()) < 1000);
});
