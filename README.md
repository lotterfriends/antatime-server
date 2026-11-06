# AnTaTime-Sync-Server

Optionaler Server, über den [AnTaTime](../antatime-app) die erfassten Zeiten zwischen mehreren Geräten abgleicht – **Ende-zu-Ende-verschlüsselt**. Der Server speichert nur Chiffretext und kann die Daten nicht lesen.

- Node.js 26 (LTS), MySQL 8.4
- Ein binäres WebSocket-Protokoll: Delta-Sync, Live-Push an andere offene Geräte (typisch < 20 ms)
- Liefert die **Web-Version der App** unter `/` aus. Die Web-App schlägt diesen Server automatisch für die Synchronisation vor
- Build: **eine ausführbare Datei** `dist/antatime-server.cjs` mit allen Abhängigkeiten und der eingebetteten Web-App (ca. 14 MB, keine `node_modules` nötig)

## Schnellstart (Docker)

```bash
docker compose up --build        # MySQL + Server mit Web-App auf http://localhost:8080
curl localhost:8080/health       # {"status":"ok","connections":0}
```

Im Browser **http://localhost:8080** öffnet die Web-App. Beim ersten Bauen klont das Image Flutter (`FLUTTER_VERSION`, Standard 3.47.9) und baut die App aus `../antatime-app`, das dauert einige Minuten. Ohne Compose: `docker build --build-context app=../antatime-app -t antatime-server .`

In der App: *Einstellungen → Synchronisation → Geräte synchronisieren*, als Server `http://localhost:8080` eintragen (Android-Emulator: `http://10.0.2.2:8080`).

## Entwicklung

```bash
npm install
docker compose up -d mysql       # nur die Datenbank
cp .env.example .env
npm run dev                      # startet src/main.ts direkt (Node-Typ-Stripping) mit --watch
                                 # Web-App aus ../antatime-app/build/web (WEB_DIR in .env)
STORE=memory npm run dev         # ganz ohne Datenbank (Daten nur im RAM)
```

| Befehl | |
| --- | --- |
| `npm run build` | bündelt nach `dist/antatime-server.cjs` (esbuild), inkl. Web-App aus `../antatime-app/build/web` (vorher `flutter build web`; anderer Pfad: `WEB_BUILD=…`, ohne: `WEB_BUILD=off`) |
| `npm start` | startet das Bundle |
| `npm test` | Protokoll- und Server-Tests (In-Memory) |
| `TEST_DATABASE_URL=mysql://antatime:antatime@127.0.0.1:3306/antatime npm test` | zusätzlich gegen MySQL |
| `npm run typecheck` | TypeScript-Prüfung |

## Betrieb

Das Bundle braucht nur Node ≥ 26 und eine MySQL-Datenbank (8.0.19+); das Schema wird beim Start angelegt.

```bash
DB_HOST=db.example.org DB_USER=antatime DB_PASSWORD=… DB_NAME=antatime \
  node antatime-server.cjs
```

| Variable | Standard | |
| --- | --- | --- |
| `PORT` / `HOST` | `8080` / `0.0.0.0` | |
| `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` | `localhost`, `3306`, `antatime`, –, `antatime` | |
| `DATABASE_URL` | – | Alternative: `mysql://user:pass@host:3306/db` |
| `STORE` | – | `memory` = ohne Datenbank (nur Tests) |
| `WEB_DIR` | – | Web-App aus diesem Verzeichnis statt der eingebetteten ausliefern; `off` = keine Web-App |
| `MAX_RECORD_BYTES` | `16384` | Größe eines verschlüsselten Datensatzes |
| `MAX_RECORDS_PER_PUSH` | `1000` | |
| `MAX_MESSAGE_BYTES` | `4194304` | WebSocket-Nachricht |
| `MAX_CONNECTIONS_PER_VAULT` | `0` | gleichzeitige Verbindungen pro Code, `0` = unbegrenzt (alle Apps mit demselben Code können gleichzeitig offen sein) |
| `MESSAGES_PER_SECOND` | `20` | pro Verbindung (Burst 10×) |

**TLS:** Der Server spricht selbst nur HTTP/`ws://`. Öffentlich gehört ein Reverse-Proxy mit TLS davor (Caddy, nginx, Traefik), der WebSocket-Upgrades auf `/sync` durchreicht. Die Inhalte sind zwar ohnehin verschlüsselt, TLS schützt aber die Metadaten (Vault-ID, Zeitpunkte, Größen). Eine per HTTPS ausgelieferte Web-App kann außerdem nur `wss://` verwenden.

Der Server ist für **eine Instanz** ausgelegt: Die Reihenfolge-Garantie (siehe unten) beruht auf einer Warteschlange pro Vault im Prozess. Mehrere Instanzen bräuchten Sticky-Routing pro Vault oder Pub/Sub.

## Web-App

Der Server liefert den Flutter-Web-Build der App unter `/` aus, `/sync` (WebSocket) und `/health` bleiben unverändert.

- **Eingebettet:** `npm run build` komprimiert den Web-Build einmalig mit Brotli (höchste Stufe; 33 MB → ca. 10 MB, ohne die Debug-Dateien `*.symbols`) und packt ihn in die Server-Datei. Browser mit Brotli bekommen die fertigen Bytes, alle anderen gzip (einmal erzeugt, dann im Speicher).
- **Verzeichnis:** Mit `WEB_DIR` liefert der Server stattdessen ein Verzeichnis aus, etwa um die App zu aktualisieren, ohne den Server neu zu bauen. Komprimiert wird beim ersten Abruf, danach aus dem Speicher.
- **Caching:** Flutter-Dateien haben keinen Inhalts-Hash im Namen, daher `Cache-Control: no-cache` mit ETag. Beim Neuladen fragt der Browser nach und bekommt ein 304 ohne Inhalt, solange sich nichts geändert hat.
- **Sync-Vorschlag:** Der Server ergänzt die `index.html` um `<meta name="antatime-sync-url" content="same-origin">`. Die App trägt dadurch im Sync-Dialog diesen Server (inkl. Unterpfad aus `<base href>`) als Adresse vor. Eine anderswo gehostete Web-App (z. B. GitHub Pages) hat die Markierung nicht.
- **Unterpfad** hinter einem Reverse-Proxy (z. B. `/antatime/`): Die App mit `flutter build web --base-href /antatime/` bauen, der Proxy entfernt den Präfix.

## Sicherheit

Der **Sync-Code** (25 Zeichen Crockford-Base32 = 125 Bit Zufall, z. B. `7K3QD-…`) wird in der App erzeugt und ist das einzige Geheimnis. Er verlässt das Gerät nie. Die App leitet daraus per HKDF-SHA256 ab:

| Ableitung | Verwendung |
| --- | --- |
| `vault` (16 Byte) | Kennung, unter der der Server die Daten ablegt. Der Server speichert davon nur `SHA-256("antatime-vault" ‖ vault)` |
| `enc` (32 Byte) | AES-256-GCM für jeden Datensatz; Nonce zufällig, Datensatz-Schlüssel als AAD (kein Vertauschen möglich) |
| `mac` (32 Byte) | HMAC-SHA256 der Datensatz-Namen (`s:<id>`, `a:<id>`, `c:<feld>`) → 16-Byte-Schlüssel, der Server sieht also nicht einmal, ob es eine Arbeitszeit oder Einstellung ist |

Der Server sieht: Vault-Hash, zufällige Datensatz-Schlüssel, Chiffretext-Größen und Zeitpunkte. Manipulierte Datensätze erkennt die App am GCM-Tag und verwirft sie. Wer den Code kennt, hat vollen Zugriff, deshalb weist die App beim Anzeigen darauf hin.

„Synchronisation beenden → auch auf dem Server löschen“ entfernt alle Datensätze und markiert den Vault als gelöscht: Verbundene Geräte beenden den Sync sofort, Geräte, die offline waren, beim nächsten Verbinden. Der Code ist danach nicht mehr verwendbar.

## Protokoll (v1)

WebSocket `/sync`, nur Binär-Frames. Erstes Byte = Opcode, Zahlen als LEB128-Varint, `key` = 16 Byte.

| Richtung | Opcode | Inhalt |
| --- | --- | --- |
| C→S | `0x01` HELLO | `u8 version, vault[16], varint lastSeq` |
| C→S | `0x02` PUSH | `varint reqId, varint n, n × (key, varint len, data)` |
| C→S | `0x03` DELETE_VAULT | – |
| C→S | `0x04` PING | – |
| S→C | `0x81` CHANGES | `varint n, n × (varint seq, key, varint len, data)` |
| S→C | `0x82` SYNCED | `varint headSeq` – Nachholen abgeschlossen |
| S→C | `0x83` ACK | `varint reqId, varint firstSeq` – Seqs `firstSeq … firstSeq+n−1` |
| S→C | `0x84` PONG | – |
| S→C | `0x85` VAULT_DELETED | – |
| S→C | `0x8F` ERROR | `u8 code, UTF-8-Text` |

Ablauf:

1. Client sendet `HELLO` mit der zuletzt übernommenen Sequenznummer.
2. Server schickt alle Datensätze mit größerer Nummer (in Blöcken zu 500) und dann `SYNCED`. Pro Schlüssel wird nur der neueste Stand gespeichert, ein Gerät, das lange offline war, lädt also nur die aktuellen Datensätze.
3. Danach: `PUSH` → Server vergibt fortlaufende Nummern, verteilt `CHANGES` sofort an die anderen Geräte des Vaults und bestätigt mit `ACK`.

Alle Aufgaben eines Vaults laufen auf dem Server strikt nacheinander. Daher gilt pro Verbindung: Fremde Änderungen kommen in Reihenfolge an, und vor einem `ACK` sind alle kleineren Nummern bereits zugestellt. Der Client kann seinen Stand also ohne Lücken auf `firstSeq+n−1` setzen und lädt eigene Änderungen nie erneut herunter.

Overhead pro Datensatz auf der Leitung: 16 Byte Schlüssel + 12 Byte Nonce + 16 Byte Tag + 2–4 Byte Längen/Seq. Eine Start/Pause-Änderung ist damit ein Frame von ~150 Byte. Keepalive: Der Client sendet nach 20 s Stille ein 1-Byte-PING; der Server prüft Verbindungen per WebSocket-Ping alle 30 s.

Konflikte löst die App: Jeder Datensatz trägt (verschlüsselt) einen Zeitstempel einer hybriden Uhr, der neueste gewinnt (Last-Writer-Wins pro Arbeitszeit, Abwesenheit bzw. Einstellung). Löschungen werden als Datensatz ohne Inhalt übertragen.
