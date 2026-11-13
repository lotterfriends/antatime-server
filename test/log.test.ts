import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { installFileLog } from '../src/log.ts';

test('LOG_FILE: Ausgaben landen mit Zeitstempel in der Datei, Rotation nach Größe', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'antatime-log-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'sync.log');

  // Konsole während des Tests stumm schalten (die Umleitung ruft sie weiter auf).
  const quiet = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  const uninstall = installFileLog(file, 200);
  try {
    console.log('Start auf Port %d', 8080);
    console.warn('Achtung', { a: 1 });
    let lines = readFileSync(file, 'utf8').trimEnd().split('\n');
    assert.equal(lines.length, 2);
    assert.match(lines[0]!, /^\d{4}-\d\d-\d\dT[\d:.]+Z LOG   Start auf Port 8080$/);
    assert.match(lines[1]!, /WARN  Achtung \{ a: 1 \}$/);

    // Über 200 Bytes: alte Zeilen wandern nach .1, die Datei beginnt neu.
    console.error('x'.repeat(150));
    assert.equal(readFileSync(`${file}.1`, 'utf8').trimEnd().split('\n').length, 2);
    lines = readFileSync(file, 'utf8').trimEnd().split('\n');
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /ERROR x{150}$/);
  } finally {
    uninstall();
    Object.assign(console, quiet);
  }
});
