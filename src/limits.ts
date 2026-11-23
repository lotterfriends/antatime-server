import type { IncomingMessage } from 'node:http';
import { BlockList, isIPv4, isIPv6 } from 'node:net';

/** Token-Bucket: [capacity] Einheiten, die mit [perSecond] nachlaufen. */
export class TokenBucket {
  private tokens: number;
  private refilledAt: number;
  private readonly capacity: number;
  private readonly perSecond: number;

  constructor(capacity: number, perSecond: number, now = Date.now()) {
    this.capacity = capacity;
    this.perSecond = perSecond;
    this.tokens = capacity;
    this.refilledAt = now;
  }

  private refill(now: number): void {
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.refilledAt) / 1000) * this.perSecond);
    this.refilledAt = now;
  }

  take(n = 1, now = Date.now()): boolean {
    this.refill(now);
    if (this.tokens < n) return false;
    this.tokens -= n;
    return true;
  }

  /** Voll = seit längerem unbenutzt, der Eintrag kann weg. */
  full(now = Date.now()): boolean {
    this.refill(now);
    return this.tokens >= this.capacity;
  }
}

export interface IpLimitConfig {
  maxConnectionsPerIp: number;
  connectsPerIpPerMinute: number;
  uploadBytesPerIpPerMinute: number;
  maxMessageBytes: number;
}

interface IpState {
  connections: number;
  connects: TokenBucket;
  upload: TokenBucket;
}

/**
 * Limits pro Client-IP (IPv6 pro /64-Netz, weil ein Anschluss meist ein
 * ganzes /64 bekommt). Ein Wert 0 schaltet das jeweilige Limit ab.
 */
export class IpLimiter {
  private readonly ips = new Map<string, IpState>();
  private readonly config: IpLimitConfig;

  constructor(config: IpLimitConfig) {
    this.config = config;
  }

  private state(ip: string): IpState {
    let s = this.ips.get(ip);
    if (!s) {
      const c = this.config;
      const perMinute = c.connectsPerIpPerMinute;
      // Ein Schwung von Nachrichten maximaler Größe muss durchpassen.
      const upload = Math.max(c.uploadBytesPerIpPerMinute, c.maxMessageBytes);
      s = {
        connections: 0,
        connects: new TokenBucket(perMinute, perMinute / 60),
        upload: new TokenBucket(upload, c.uploadBytesPerIpPerMinute / 60),
      };
      this.ips.set(ip, s);
    }
    return s;
  }

  /** Neue Verbindung: `null` = erlaubt (und gezählt), sonst der Grund. */
  connect(ip: string): string | null {
    const c = this.config;
    const s = this.state(ip);
    if (c.maxConnectionsPerIp > 0 && s.connections >= c.maxConnectionsPerIp) {
      return 'Zu viele Verbindungen von dieser Adresse';
    }
    if (c.connectsPerIpPerMinute > 0 && !s.connects.take()) {
      return 'Zu viele Verbindungsversuche von dieser Adresse';
    }
    s.connections++;
    return null;
  }

  disconnect(ip: string): void {
    const s = this.ips.get(ip);
    if (s && s.connections > 0) s.connections--;
  }

  /** Eingehende Bytes; `false` = Upload-Kontingent der Adresse erschöpft. */
  upload(ip: string, bytes: number): boolean {
    if (this.config.uploadBytesPerIpPerMinute <= 0) return true;
    return this.state(ip).upload.take(bytes);
  }

  /** Entfernt Einträge ohne Verbindungen, deren Kontingente wieder voll sind. */
  sweep(now = Date.now()): void {
    for (const [ip, s] of this.ips) {
      if (s.connections === 0 && s.connects.full(now) && s.upload.full(now)) this.ips.delete(ip);
    }
  }

  get size(): number {
    return this.ips.size;
  }
}

/** Standard für `TRUSTED_PROXIES`: Loopback und private Netze (Reverse-Proxy, Docker). */
export const DEFAULT_TRUSTED_PROXIES = ['127.0.0.0/8', '::1', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', 'fc00::/7'];

/**
 * Adressen, deren Client-IP-Header geglaubt wird. Einträge: einzelne IPs oder
 * CIDR-Netze, IPv4 und IPv6. Wirft bei ungültigen Einträgen.
 */
export class TrustedProxies {
  private readonly list = new BlockList();

  constructor(entries: readonly string[]) {
    for (const raw of entries) {
      const entry = raw.trim();
      if (!entry) continue;
      const [addr = '', bits, extra] = entry.split('/');
      const family = isIPv4(addr) ? 'ipv4' : isIPv6(addr) ? 'ipv6' : null;
      const max = family === 'ipv4' ? 32 : 128;
      const prefix = bits === undefined ? max : Number(bits);
      if (!family || extra !== undefined || !/^\d+$/.test(bits ?? '0') || prefix > max) {
        throw new Error(`TRUSTED_PROXIES: ungültiger Eintrag „${entry}“`);
      }
      this.list.addSubnet(addr, prefix, family);
    }
  }

  has(address: string): boolean {
    const ip = address.replace(/^\[|\]$/g, '').replace(/%.*$/, '');
    // IPv4-mapped (::ffff:10.0.0.1) muss auf IPv4-Einträge passen.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)?.[1];
    if (mapped) return this.list.check(mapped, 'ipv4');
    if (isIPv4(ip)) return this.list.check(ip, 'ipv4');
    if (isIPv6(ip)) return this.list.check(ip, 'ipv6');
    return false;
  }
}

/**
 * Adresse des Clients. Hinter einem Reverse-Proxy steht sie in einem Header
 * ([header], z. B. `x-forwarded-for` oder `cf-connecting-ip`); bei
 * mehreren Einträgen zählt der letzte, den hat der eigene Proxy angehängt.
 * Der Header zählt nur, wenn die Verbindung von einem [trusted] Proxy kommt –
 * sonst könnte jeder, der den Port direkt erreicht, eine beliebige IP vorgeben
 * und die Limits pro IP umgehen. Ohne Socket-Adresse (Unix-Socket, etwa bei
 * Passenger) ist die Gegenstelle lokal und damit vertrauenswürdig.
 */
export function clientIp(req: IncomingMessage, header: string, trusted: TrustedProxies): string | undefined {
  const addr = req.socket.remoteAddress;
  if (header && (!addr || trusted.has(addr))) {
    const raw = req.headers[header.toLowerCase()];
    const value = Array.isArray(raw) ? raw[raw.length - 1] : raw;
    const ip = value?.split(',').pop()?.trim();
    if (ip) return ipKey(ip);
  }
  return addr ? ipKey(addr) : undefined;
}

/** IPv4 unverändert, IPv6 auf das /64-Netz gekürzt. */
export function ipKey(ip: string): string {
  ip = ip.replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  if (ip.startsWith('::ffff:') && ip.includes('.')) return ip.slice(7);
  if (!ip.includes(':')) return ip;
  let groups: string[];
  if (ip.includes('::')) {
    const [head = '', tail = ''] = ip.split('::');
    const h = head ? head.split(':') : [];
    const t = tail ? tail.split(':') : [];
    groups = [...h, ...Array<string>(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  } else {
    groups = ip.split(':');
  }
  return groups
    .slice(0, 4)
    .map((g) => (parseInt(g, 16) || 0).toString(16))
    .join(':') + '::/64';
}
