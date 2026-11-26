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
| `UPDATES_DIR` | – | Verzeichnis mit App-Paketen, die der Server als Updates anbietet – nur nötig, wenn die Apps nicht von GitHub laden sollen (siehe [App-Updates](#app-updates)); ohne Angabe gibt es `/updates/` nicht |
| `WEB_DIR` | – | Web-App aus diesem Verzeichnis statt der eingebetteten ausliefern; `off` = keine Web-App |
| `MAX_RECORD_BYTES` | `16384` | Größe eines verschlüsselten Datensatzes |
| `MAX_RECORDS_PER_PUSH` | `1000` | |
| `MAX_MESSAGE_BYTES` | `4194304` | WebSocket-Nachricht |
| `MAX_CONNECTIONS_PER_VAULT` | `0` | gleichzeitige Verbindungen pro Code, `0` = unbegrenzt (alle Apps mit demselben Code können gleichzeitig offen sein) |
| `MESSAGES_PER_SECOND` | `20` | pro Verbindung (Burst 10×), `0` = unbegrenzt |
| `MAX_CONNECTIONS` | `5000` | gleichzeitige Verbindungen insgesamt |
| `MAX_CONNECTIONS_PER_IP` | `20` | gleichzeitig pro IP (IPv6: pro /64-Netz) |
| `CONNECTS_PER_IP_PER_MINUTE` | `30` | neue Verbindungen pro IP und Minute |
| `UPLOAD_BYTES_PER_IP_PER_MINUTE` | `10485760` | hochgeladene Bytes pro IP und Minute (10 MB) |
| `MAX_VAULT_RECORDS` / `MAX_VAULT_BYTES` | `100000` / `67108864` | Speicher-Kontingent pro Sync-Code (64 MB) |
| `MAX_TOTAL_BYTES` | `10737418240` | Speicher aller Sync-Codes zusammen (10 GB); danach nimmt der Server nur noch Änderungen an, die nichts vergrößern. Weiches Limit: Die Gesamtbelegung wird nur alle 10 s aus der Datenbank gelesen und dazwischen im Prozess fortgeschrieben (gleichzeitige Pushes eingerechnet); Schreiben andere Prozesse in dieselbe Datenbank, kann es um deren Zuwachs überschritten werden |
| `VAULT_TTL_DAYS` | `365` | Sync-Codes, die so lange kein Gerät benutzt hat, werden entfernt (auch gelöschte, nie solche mit verbundenem Gerät); kehrt ein Gerät zurück, erkennt es an der neuen Epoche in `SYNCED`, dass der Vault neu angelegt wurde, und lädt seine Daten neu hoch. `0` = nie |
| `HELLO_TIMEOUT_MS` | `10000` | Verbindungen ohne HELLO werden danach getrennt |
| `MAX_SEND_BUFFER_BYTES` | `4194304` | Ungelesene Sendedaten pro Verbindung (4 MB); darüber wird getrennt |
| `SEND_STALL_TIMEOUT_MS` | `30000` | Liest ein Client beim Nachholen so lange nichts, wird getrennt |
| `LOG_FILE` | – | Log-Ausgaben zusätzlich mit Zeitstempel an diese Datei anhängen – für Hoster, bei denen die Konsolenausgabe nicht einsehbar ist (z. B. Plesk/Passenger) |
| `LOG_FILE_MAX_BYTES` | `5242880` | Ab dieser Größe wird die Logdatei nach `<LOG_FILE>.1` verschoben und neu begonnen (5 MB); `0` = nie |
| `CLIENT_IP_HEADER` | – | hinter einem Proxy: Header mit der Client-IP, z. B. `x-forwarded-for` (letzter Eintrag zählt) oder `cf-connecting-ip` |
| `TRUSTED_PROXIES` | Loopback und private Netze | kommagetrennte IPs/CIDR-Netze (IPv4 und IPv6), deren `CLIENT_IP_HEADER` geglaubt wird; bei allen anderen zählt die Socket-Adresse, damit niemand am Proxy vorbei eine fremde IP vorgeben kann. Standard: `127.0.0.0/8,::1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,fc00::/7` (passt für Proxy auf demselben Rechner oder im Docker-Netz). Steht der Proxy unter einer öffentlichen Adresse, diese eintragen. Verbindungen ohne Socket-Adresse (Unix-Socket, z. B. Passenger) gelten als vertrauenswürdig |

Limits mit dem Wert `0` sind abgeschaltet. Außerdem nimmt der Server pro Verbindung höchstens 8 unbestätigte PUSHes bzw. 16 MB an. Überschreitungen beantwortet der Server beim Verbindungsaufbau mit HTTP 429 und sonst mit `ERROR` (`4` = zu viel, `7` = Kontingent voll), danach trennt er die Verbindung. Die App verbindet sich mit Backoff neu. Ist die Client-IP nicht bekannt, warnt der Server einmal im Log, und die Limits pro IP greifen nicht.

**TLS:** Der Server spricht selbst nur HTTP/`ws://`. Öffentlich gehört ein Reverse-Proxy mit TLS davor (Caddy, nginx, Traefik), der WebSocket-Upgrades auf `/sync` durchreicht. Die Inhalte sind zwar ohnehin verschlüsselt, TLS schützt aber die Metadaten (Vault-ID, Zeitpunkte, Größen). Eine per HTTPS ausgelieferte Web-App kann außerdem nur `wss://` verwenden.

Der Server ist für **eine Instanz** ausgelegt: Die Reihenfolge-Garantie (siehe unten) beruht auf einer Warteschlange pro Vault im Prozess. Mehrere Instanzen bräuchten Sticky-Routing pro Vault oder Pub/Sub.

**Plesk (Node.js über Passenger):** Die Konsolenausgabe der App ist dort nicht einsehbar, und die Socket-Adresse ist leer, weil Passenger über einen Unix-Socket weiterleitet. Unter Node.js → Umgebung setzen:

- `LOG_FILE=../sync-logs/sync.log` – relativ zum Anwendungsstamm (`httpdocs`), daher unabhängig vom Abo-Verzeichnis; den Ordner `sync-logs` vorher neben `httpdocs` anlegen (nicht in `httpdocs`, sonst ist die Datei womöglich öffentlich abrufbar)
- `CLIENT_IP_HEADER=!~passenger-client-address` – Passenger setzt diesen internen Header selbst aus der Adresse, die nginx sieht; Clients können ihn nicht vorgeben. Eigene nginx-Anweisungen sind dafür nicht nötig.

Danach die App neu starten. Fehlt die Client-IP, nennt die Warnung im Log die empfangenen Header. Passenger startet die App gelegentlich neu (beim Neuladen von nginx durch Plesk); die Apps verbinden sich dann nach wenigen Sekunden von selbst wieder.

## Web-App

Der Server liefert den Flutter-Web-Build der App unter `/` aus, `/sync` (WebSocket) und `/health` bleiben unverändert.

- **Eingebettet:** `npm run build` komprimiert den Web-Build einmalig mit Brotli (höchste Stufe; 33 MB → ca. 10 MB, ohne die Debug-Dateien `*.symbols`) und packt ihn in die Server-Datei. Browser mit Brotli bekommen die fertigen Bytes, alle anderen gzip (einmal erzeugt, dann im Speicher).
- **Verzeichnis:** Mit `WEB_DIR` liefert der Server stattdessen ein Verzeichnis aus, etwa um die App zu aktualisieren, ohne den Server neu zu bauen. Komprimiert wird beim ersten Abruf, danach aus dem Speicher.
- **Caching:** Flutter-Dateien haben keinen Inhalts-Hash im Namen, daher `Cache-Control: no-cache` mit ETag. Beim Neuladen fragt der Browser nach und bekommt ein 304 ohne Inhalt, solange sich nichts geändert hat.
- **Sync-Vorschlag:** Der Server ergänzt die `index.html` um `<meta name="antatime-sync-url" content="same-origin">`. Die App trägt dadurch im Sync-Dialog diesen Server (inkl. Unterpfad aus `<base href>`) als Adresse vor. Eine anderswo gehostete Web-App (z. B. GitHub Pages) hat die Markierung nicht.
- **Unterpfad** hinter einem Reverse-Proxy (z. B. `/antatime/`): Die App mit `flutter build web --base-href /antatime/` bauen, der Proxy entfernt den Präfix.

## App-Updates

Die Android-App (als APK installiert) und die Desktop-Apps holen ihre Updates normalerweise direkt aus den GitHub-Releases der App – dafür braucht dieser Server nichts zu tun. Er kann die Pakete aber auch selbst anbieten, etwa wenn das Repository privat ist: Die App mit `UPDATE_URL=<dieser Server>` bauen, `UPDATES_DIR` auf ein Verzeichnis zeigen lassen und die Pakete aus `antatime-app/dist/` hineinkopieren – unter den Namen, die die Build-Skripte vergeben:

```
antatime-1.6.0.apk
AnTaTime-1.6.0-x86_64.AppImage
antatime_1.6.0_amd64.deb
antatime-1.6.0-linux-x64.tar.gz
AnTaTime-1.6.0-windows-x64-setup.exe
antatime-1.6.0-windows-x64.zip
AnTaTime-1.6.0-macos.dmg
```

```bash
rsync -av ../antatime-app/dist/*-1.6.0* ../antatime-app/dist/*_1.6.0_* server:/pfad/zu/updates/
```

- `GET /updates/latest.json` nennt je Paketart (und Architektur) die **höchste Version** im Verzeichnis, mit Größe und SHA-256. Ältere Pakete dürfen liegen bleiben. Die Prüfsumme wird je Datei einmal berechnet; das Verzeichnis wird höchstens alle 10 s neu gelesen, ein Neustart ist nicht nötig.
- `GET /updates/<datei>` liefert ein Paket. Abrufbar sind nur Dateien mit einem der Namen oben, nichts anderes aus dem Verzeichnis.
- Neue Pakete zuerst unter einem anderen Namen hochladen und dann umbenennen (rsync macht das von selbst) – sonst könnte eine App eine halbe Datei angeboten bekommen. Sie würde sie an der Prüfsumme erkennen und verwerfen.
- Die Apps fragen nur den Server, der bei ihrem Build mit `UPDATE_URL` festgelegt wurde (siehe README der App), und nur über HTTPS. Android installiert außerdem nur APKs, die mit demselben Schlüssel signiert sind wie die installierte App. Für Linux, Windows und macOS gibt es keine solche Signatur: Wer Pakete in dieses Verzeichnis legen kann, kann Code auf den Rechnern der Benutzer ausführen – Schreibrechte entsprechend knapp halten.
- Docker: das Verzeichnis als Volume einhängen, z. B. `-v /srv/antatime-updates:/updates:ro -e UPDATES_DIR=/updates`.

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
| S→C | `0x82` SYNCED | `varint headSeq, varint serverTime, varint epoch` – Nachholen abgeschlossen; `serverTime` = Serveruhr in ms seit 1970, `epoch` = Generation des Vaults (siehe unten). Ältere Server senden nur `headSeq` bzw. `headSeq, serverTime` |
| S→C | `0x83` ACK | `varint reqId, varint firstSeq` – Seqs `firstSeq … firstSeq+n−1` |
| S→C | `0x84` PONG | – |
| S→C | `0x85` VAULT_DELETED | – |
| S→C | `0x8F` ERROR | `u8 code, UTF-8-Text` |

Ablauf:

1. Client sendet `HELLO` mit der zuletzt übernommenen Sequenznummer.
2. Server schickt alle Datensätze mit größerer Nummer (in Blöcken zu 500) und dann `SYNCED`. Pro Schlüssel wird nur der neueste Stand gespeichert, ein Gerät, das lange offline war, lädt also nur die aktuellen Datensätze.
3. Danach: `PUSH` → Server vergibt fortlaufende Nummern, verteilt `CHANGES` sofort an die anderen Geräte des Vaults und bestätigt mit `ACK`.

**Epoche:** Läuft ein Vault ab und wird später neu angelegt, beginnen die Sequenznummern wieder bei 1. Damit ein Gerät mit altem `lastSeq` dabei nichts verpasst, trägt jeder Vault eine zufällige Epoche (48 Bit, nie 0), die sich nur beim Neuanlegen ändert; Vaults aus der Zeit vor den Epochen haben `0`. Der Server legt den Vault schon beim `HELLO` an, sodass bereits das erste `SYNCED` die gültige Epoche trägt. Weicht sie von der gemerkten ab, verwirft der Client `lastSeq`, holt ab `0` nach und lädt seine Daten neu hoch.

Alle Aufgaben eines Vaults laufen auf dem Server strikt nacheinander. Daher gilt pro Verbindung: Fremde Änderungen kommen in Reihenfolge an, und vor einem `ACK` sind alle kleineren Nummern bereits zugestellt. Der Client kann seinen Stand also ohne Lücken auf `firstSeq+n−1` setzen und lädt eigene Änderungen nie erneut herunter.

Overhead pro Datensatz auf der Leitung: 16 Byte Schlüssel + 12 Byte Nonce + 16 Byte Tag + 2–4 Byte Längen/Seq. Eine Start/Pause-Änderung ist damit ein Frame von ~150 Byte. Keepalive: Der Client sendet nach 20 s Stille ein 1-Byte-PING; der Server prüft Verbindungen per WebSocket-Ping alle 30 s.

Konflikte löst die App: Jeder Datensatz trägt (verschlüsselt) einen Zeitstempel einer hybriden Uhr, der neueste gewinnt (Last-Writer-Wins pro Arbeitszeit, Abwesenheit bzw. Einstellung). Löschungen werden als Datensatz ohne Inhalt übertragen.
