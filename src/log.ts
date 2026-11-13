import { appendFileSync, renameSync, statSync } from 'node:fs';
import { format } from 'node:util';

type Level = 'log' | 'info' | 'warn' | 'error';
const LEVELS: Level[] = ['log', 'info', 'warn', 'error'];

/**
 * Schreibt alle Konsolenausgaben (`console.log/info/warn/error`) zusätzlich
 * mit Zeitstempel in [path]. Gedacht für Hoster wie Plesk/Passenger, bei
 * denen die Konsolenausgabe der App nicht einsehbar ist.
 *
 * Wird die Datei größer als [maxBytes], wird sie nach `<path>.1` verschoben
 * (eine ältere Datei dort wird überschrieben) und neu begonnen. Die Ausgabe
 * ist selten (höchstens eine Zeile pro Heartbeat plus Fehler), daher wird
 * synchron geschrieben – nichts geht bei einem Absturz verloren.
 *
 * Gibt eine Funktion zurück, die die Umleitung wieder entfernt.
 */
export function installFileLog(path: string, maxBytes = 5 * 1024 * 1024): () => void {
  let bytes = 0;
  try {
    bytes = statSync(path).size;
  } catch {
    // Datei existiert noch nicht.
  }
  const original = Object.fromEntries(LEVELS.map((l) => [l, console[l]])) as Record<
    Level,
    (...args: unknown[]) => void
  >;
  let failed = false;

  const write = (level: Level, args: unknown[]) => {
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${format(...args)}\n`;
    const size = Buffer.byteLength(line);
    try {
      if (maxBytes > 0 && bytes > 0 && bytes + size > maxBytes) {
        renameSync(path, `${path}.1`);
        bytes = 0;
      }
      appendFileSync(path, line);
      bytes += size;
      failed = false;
    } catch (e) {
      // Nur einmal melden, sonst erzeugt jede Zeile eine weitere Fehlermeldung.
      if (!failed) original.error(`LOG_FILE ${path} nicht beschreibbar:`, e);
      failed = true;
    }
  };

  for (const level of LEVELS) {
    console[level] = (...args: unknown[]) => {
      original[level](...args);
      write(level, args);
    };
  }
  return () => {
    for (const level of LEVELS) console[level] = original[level];
  };
}
