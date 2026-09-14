# Project Blueprint

ARBEITSREGELN (gelten für die gesamte Session):

1. Diff-Modus: Erst Bestandsaufnahme zeigen, dann Diff vorschlagen. NICHTS anwenden ohne explizite FREIGABE.

2. Nach jeder Anwendung: Vollzugsmeldung mit Liste der tatsächlich geänderten Dateien und Migrationen, Zeilenanzahl pro Datei einzeln aufgeführt (nicht zusammengefasst).

3. Bestehende Muster wiederverwenden, keine ungefragten Design- oder Architekturentscheidungen.

4. Abweichungen vom Auftrag ehrlich melden. "Keine Abweichungen" nur, wenn tatsächlich keine da sind.

AUFGABE 1 — Bestandsaufnahme des neuen, leeren Projekts, keine Änderungen:

Zeige mir:

(1) den tatsächlichen Tech-Stack, den dieses neue Projekt mitbringt (Framework, Vite/Build-Setup, Tailwind-Version, ob Supabase automatisch verbunden ist),

(2) wie Lovable Auth in diesem Projekt aktiviert wird und wie sich pro Nutzer eine feste Rolle (z. B. custom Feld oder Tabelle) hinterlegen lässt,

(3) ob Supabase Realtime Channels verfügbar und aktivierbar sind, und ob damit ein Broadcast von einem Sender an mehrere gleichzeitige Empfänger (1 Sender, bis zu 5 stille Zuhörer) technisch sauber umsetzbar wäre — oder ob dafür ein separater persistenter WebSocket-Prozess nötig wäre,

(4) ob und wie Edge Functions verfügbar sind, über die Server-seitige API-Calls mit geheimen Keys (Deepgram, OpenAI) laufen könnten, ohne dass die Keys im Client landen.

Nur berichten, nichts vorschlagen, nichts ändern.

This project was built with [Lovable](https://lovable.dev).

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/a9fd95a8-f156-4ec8-b783-b32c4f093c60).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```
