import {
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import type { KeyObject } from 'node:crypto';

/**
 * Optionale Anmeldung am Server (X25519).
 *
 * Der Server hält einen privaten Schlüssel (`SERVER_PRIVATE_KEY`). Den
 * zugehörigen öffentlichen „Server-Schlüssel“ gibt der Betreiber an seine
 * Nutzer weiter; sie tragen ihn in App oder Widget ein. Nur wer ihn kennt,
 * kann sich anmelden – er wird dabei nie übertragen:
 *
 *   S→C CHALLENGE  nonce[32]
 *   C→S AUTH       ephPub[32], mac[32]
 *   S→C AUTH_OK    proof[32]
 *
 *   k     = HKDF-SHA256(X25519(eph, server), salt "antatime-auth-v1",
 *                       info nonce ‖ ephPub ‖ serverPub)
 *   mac   = HMAC-SHA256(k, "client" ‖ nonce)
 *   proof = HMAC-SHA256(k, "server" ‖ nonce)
 *
 * Mit `proof` weist sich umgekehrt der Server aus: Nur der Besitzer des
 * privaten Schlüssels kann ihn berechnen. Wer den Server-Schlüssel kennt,
 * kann sich also anmelden, aber nicht als Server ausgeben.
 */
export const AUTH_KEY_LENGTH = 32;
export const AUTH_NONCE_LENGTH = 32;
export const AUTH_MAC_LENGTH = 32;

const SALT = Buffer.from('antatime-auth-v1');
const PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');
const SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
/** Crockford-Base32 wie beim Sync-Code (ohne I, L, O, U). */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** 32 Byte = 256 Bit → 52 Zeichen (die letzten 4 Bit sind 0). */
export const KEY_TEXT_LENGTH = 52;

/** Schlüssel als Text, gut lesbar in Vierergruppen. */
export function encodeKey(key: Uint8Array): string {
  let out = '';
  let acc = 0;
  let bits = 0;
  for (const b of key) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(acc >> bits) & 31];
    }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) out += ALPHABET[(acc << (5 - bits)) & 31];
  return out.match(/.{1,4}/g)!.join('-');
}

/**
 * Liest einen Schlüssel; tolerant wie beim Sync-Code (Groß-/Kleinschreibung,
 * Trennzeichen, O→0, I/L→1). `null`, wenn es kein gültiger Schlüssel ist.
 */
export function decodeKey(text: string): Buffer | null {
  const s = text
    .toUpperCase()
    .replace(/[\s\-_.]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  if (s.length !== KEY_TEXT_LENGTH) return null;
  const out = Buffer.alloc(AUTH_KEY_LENGTH);
  let acc = 0;
  let bits = 0;
  let pos = 0;
  for (const c of s) {
    const v = ALPHABET.indexOf(c);
    if (v < 0) return null;
    acc = (acc << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      if (pos < out.length) out[pos++] = (acc >> bits) & 0xff;
      acc &= (1 << bits) - 1;
    }
  }
  // Die überzähligen Bits müssen 0 sein, sonst gäbe es mehrere Schreibweisen.
  return acc === 0 ? out : null;
}

function privateKeyOf(raw: Uint8Array): KeyObject {
  return createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, raw]), format: 'der', type: 'pkcs8' });
}

function publicKeyOf(raw: Uint8Array): KeyObject {
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
}

function rawPublic(key: KeyObject): Buffer {
  const der = (key.type === 'private' ? createPublicKey(key) : key).export({ format: 'der', type: 'spki' });
  return Buffer.from(der.subarray(der.length - AUTH_KEY_LENGTH));
}

function rawPrivate(key: KeyObject): Buffer {
  const der = key.export({ format: 'der', type: 'pkcs8' });
  return Buffer.from(der.subarray(der.length - AUTH_KEY_LENGTH));
}

function sessionKey(shared: Buffer, nonce: Uint8Array, ephPub: Uint8Array, serverPub: Uint8Array): Buffer {
  return Buffer.from(hkdfSync('sha256', shared, SALT, Buffer.concat([nonce, ephPub, serverPub]), 32));
}

function mac(key: Buffer, role: 'client' | 'server', nonce: Uint8Array): Buffer {
  return createHmac('sha256', key).update(role).update(nonce).digest();
}

/** Neues Schlüsselpaar als Text: `privateKey` für den Server, `publicKey` für die Apps. */
export function generateServerKey(): { privateKey: string; publicKey: string } {
  const pair = generateKeyPairSync('x25519');
  return { privateKey: encodeKey(rawPrivate(pair.privateKey)), publicKey: encodeKey(rawPublic(pair.publicKey)) };
}

/** Server-Seite der Anmeldung. */
export class ServerAuth {
  private readonly privateKey: KeyObject;
  private readonly publicRaw: Buffer;

  /** [privateKeyText] = Wert von `SERVER_PRIVATE_KEY`; wirft, wenn ungültig. */
  constructor(privateKeyText: string) {
    const raw = decodeKey(privateKeyText);
    if (!raw) {
      throw new Error(
        `SERVER_PRIVATE_KEY ist ungültig (erwartet: ${KEY_TEXT_LENGTH} Zeichen, erzeugen mit „antatime-server keygen“)`,
      );
    }
    this.privateKey = privateKeyOf(raw);
    this.publicRaw = rawPublic(this.privateKey);
  }

  /** Der Server-Schlüssel, den Nutzer in App und Widget eintragen. */
  get publicKey(): string {
    return encodeKey(this.publicRaw);
  }

  challenge(): Buffer {
    return randomBytes(AUTH_NONCE_LENGTH);
  }

  /**
   * Prüft die Antwort auf [nonce]. Liefert den Nachweis für AUTH_OK oder
   * `null`, wenn der Client den Server-Schlüssel nicht kennt.
   */
  verify(nonce: Uint8Array, ephPub: Uint8Array, clientMac: Uint8Array): Buffer | null {
    let shared: Buffer;
    try {
      shared = diffieHellman({ privateKey: this.privateKey, publicKey: publicKeyOf(ephPub) });
    } catch {
      return null; // ungültiger Punkt
    }
    if (shared.every((b) => b === 0)) return null;
    const key = sessionKey(shared, nonce, ephPub, this.publicRaw);
    const expected = mac(key, 'client', nonce);
    if (clientMac.length !== expected.length || !timingSafeEqual(expected, clientMac)) return null;
    return mac(key, 'server', nonce);
  }
}

/**
 * Client-Seite – für Tests und Werkzeuge (App und Widget haben eigene
 * Umsetzungen). Liefert die Felder für AUTH und den erwarteten Nachweis.
 */
export function answerChallenge(
  serverKeyText: string,
  nonce: Uint8Array,
): { ephPub: Buffer; mac: Buffer; proof: Buffer } {
  const serverPub = decodeKey(serverKeyText);
  if (!serverPub) throw new Error('Ungültiger Server-Schlüssel');
  const eph = generateKeyPairSync('x25519');
  const ephPub = rawPublic(eph.publicKey);
  const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: publicKeyOf(serverPub) });
  const key = sessionKey(shared, nonce, ephPub, serverPub);
  return { ephPub, mac: mac(key, 'client', nonce), proof: mac(key, 'server', nonce) };
}
