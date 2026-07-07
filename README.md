# Betsson & Bindus

Privat plattform för vänskaps-betting — Jasmine & Erikas egna VM-bets, plus ett litet casino. Inga riktiga pengar, inga transaktioner. Statisk front-end (HTML/CSS/JS), helt datadriven via JSON.

**Live:** https://stampetherabbit.github.io/betsson-bindus/

## Uppdatera efter en match

Allt innehåll bor i två filer. Sajten renderar om sig själv från dem — ingen kod behöver röras.

### `data/matches.json` — matcher & odds

- **Efter slutsignal:** sätt matchens `"status"` till `"finished"` och fyll i `"result"`: `{ "homeScore": 2, "awayScore": 1 }`. Matchen flyttas då till "Spelade" och odds-knapparna låses.
- **Ny match klar (t.ex. semifinal):** byt ut `home`/`away` (namn + landskod), sätt `"status"` till `"open"` och lägg in ett `markets`-block med odds — kopiera strukturen från en befintlig match och byt id:n.
- **Justera odds:** ändra bara `"odds"`-värdet. `"openingOdds"` lämnas orörd — pilen på oddsknappen visar rörelsen sedan öppning.
- **Vinnar-oddsen** (`outrights`): varje rad har `name` + `code` (landskod för flaggan) + `odds`. Ta bort utslagna lag eller justera odds fritt.
- Datum/tider är svensk tid (ISO-format med `+02:00`).

### `data/bets.json` — era spel & leaderboard

Ett spel = ett objekt i `"bets"`:

```json
{
  "id": "j-006",
  "member": "jasmine",
  "placedAt": "2026-07-09",
  "type": "single",
  "stake": 100,
  "selections": [
    { "match": "Frankrike – Marocko", "stage": "Kvartsfinal", "market": "Matchresultat", "pick": "Frankrike", "odds": 1.72 }
  ],
  "result": "open"
}
```

- `member`: `"jasmine"` eller `"erika"`
- `type`: `"single"` (en rad) eller `"kombi"` (flera objekt i `selections` — totalodds = produkten av raderna)
- `result`: `"open"` tills matchen är avgjord, sedan `"won"` eller `"lost"`
- Leaderboard, träffsäkerhet och netto räknas ut automatiskt från listan.
- **Exempeldata:** filen levereras med påhittade spel och `"exampleData": true` i `meta` — sajten visar då en liten markering. Ersätt spelen med era riktiga och sätt `"exampleData": false`.

### `data/slots.json` — casinospelen

- Ett spel = ett objekt i `"games"`: namn, tema-färger (`accent`, `artFrom`, `artTo`), symboler och vinsttabell.
- Per symbol: `weight` = relativ sannolikhet, `pay` = multiplikator av insatsen vid 3/4/5 i rad på vinstlinjen (mittraden, från vänster).
- `topSymbol`: fem sådana på vinstlinjen vinner **Bindus-jackpotten** (tickar upp i `localStorage`, återställs till `meta.jackpot.seed` vid vinst).
- Saldot delas med sportsboken — allt är fiktivt.

### Publicera ändringar

```bash
cd operational/projekt/betsson-bindus/hemsida
git add data/ && git commit -m "Uppdaterade matcher/bets efter <match>" && git push
```

GitHub Pages bygger om automatiskt (~30–90 s).

## Struktur

```
index.html      — hela sajten (en sida)
css/            — stilar
js/             — rendering + bet slip-logik (läser data/*.json)
data/           — matches.json + bets.json  ← ENDA filerna som behöver redigeras
assets/         — favicon, og-bild, grafik
fonts/          — Archivo Variable (woff2) + OFL-licens
```

## Juridisk not

Sajten är en privat plattform för två vänners egna VM-tips sinsemellan. Ingen penninghantering, inga insättningar, ingen spelverksamhet. Namnet är en intern ordvits — ej affilierad med Betsson AB. Ej för publik lansering utan namn-/varumärkesöversyn.
