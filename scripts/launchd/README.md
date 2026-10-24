# Veckokörningen (LaunchAgent)

Bostad AI kan köra bevakningen av innerstan själv varje måndag klockan 07:00 på den här Macen.
Det här är dokumentationen. Ingenting av detta är installerat av Phase 14.2: att lägga in
agenten rör dina egna användaragenter, så du gör det själv med en rad (se "Installera").

## Vad som körs och när

- **När:** måndag 07:00 lokal tid (`StartCalendarInterval`, `Weekday` 1). Agenten startar inte vid
  inläsning (`RunAtLoad` saknas), så `launchctl bootstrap` startar ingen körning.
- **Vad:** `scripts/launchd/run-weekly.sh`, som kör
  `./node_modules/.bin/tsx scripts/fit-score.ts --renderer local --window all --email` (med `caffeinate -i -w` vid sidan om).
  - `--renderer local`: Booli läses av en synlig Chromium på den här Macen. Gratis.
  - `--window all`: alla jämförbara annonser får detaljsida, mäklarsida och bildtolkning.
  - `--email`: bevakningsminnet avgör vad som är nytt; mejlet innehåller bara nya eller prisändrade annonser.
  - `--allow-apify` skickas **aldrig** med. Veckojobbet kan inte kosta Apify-pengar (R-03).
- **Sömn:** `caffeinate -i -w <skriptets pid>` håller Macen vaken precis så länge skriptet lever och inte längre.
- **Stopp:** när launchd stoppar jobbet (utloggning, avstängning) skickar den SIGTERM till skriptet, som
  vidarebefordrar den till körningen. Körningen stänger då webbläsaren och släpper låset innan den avslutar (kod 143).
- **Miljön:** skriptet läser `~/.zshenv` (API-nyckel och SMTP-variabler ligger där). Inga hemligheter
  finns i plisten, och skriptet skriver aldrig ut miljön.
- **Tider:** loggen får raderna `Start: <tid>` och `Slut: <tid>, kod <n>`, så en försenad körning syns.

Första mejlet innehåller de 15 främsta annonserna i varje avsnitt ("Förväntat under 4 M" och
"Över 4 M förväntat"). Därefter innehåller varje mejl bara annonser som är nya sedan förra veckan eller
vars utgångspris ändrats. En vecka utan nyheter skickar och skriver ingenting.

## Installera

```sh
cd /Users/danielwesterholm/dev/legendary-umbrella
plutil -lint scripts/launchd/com.bostadai.weekly-watch.plist
cp scripts/launchd/com.bostadai.weekly-watch.plist ~/Library/LaunchAgents/ && launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.bostadai.weekly-watch.plist
```

## Provköra direkt

```sh
launchctl kickstart -k gui/$(id -u)/com.bostadai.weekly-watch
```

Utan att starta något, bara förkontroller (renderare, SMTP satt/saknas, bevakningsminne, lås):

```sh
WATCH_DRY_RUN=1 zsh scripts/launchd/run-weekly.sh
```

## Ta bort

```sh
launchctl bootout gui/$(id -u)/com.bostadai.weekly-watch
rm ~/Library/LaunchAgents/com.bostadai.weekly-watch.plist
```

## Logg

`~/Library/Logs/bostadai-weekly-watch.log` (stdout och stderr i samma fil).

```sh
tail -f ~/Library/Logs/bostadai-weekly-watch.log
```

## Valfritt: väck Macen före körningen

Macen här sover efter en minut utan aktivitet. `caffeinate -i` hindrar sömn under körningen men väcker
inte en sovande Mac. Vill du att den vaknar klockan 06:55 på måndagar:

```sh
sudo pmset repeat wakeorpoweron M 06:55:00
```

Det ändrar en energiinställning och kräver administratörslösenord, så Phase 14.2 har inte kört det.
Det kan bara finnas en återkommande väckning åt gången; kommandot ersätter en eventuell befintlig.
Ta bort den med `sudo pmset repeat cancel`.

## Att veta

- Agenten körs bara medan du är inloggad (det är en LaunchAgent, med tillgång till skärmen för den
  synliga webbläsaren). Utloggad Mac: ingen körning.
- Stängt lock på batteri: Macen sover och körningen väntar.
- Missad körning: om Macen sov klockan 07:00 startar launchd jobbet när den vaknar.
- Två körningar samtidigt går inte: en andra körning (till exempel för hand under den schemalagda)
  ser låset `watch-state.lock` och avslutar med kod 3.
- Låst skärm är sannolikt okej för den synliga Chromium, men det är inte provat över natten.

## E-post (SMTP)

Lägg till i `~/.zshenv` (värdena skrivs aldrig ut av någon körning, bara `satt` eller `saknas`):

```sh
export WATCH_SMTP_URL='smtp://ANVÄNDARE:LÖSENORD[snabel-a]VÄRD:587'   # byt [snabel-a] mot tecknet @; smtps:// går också
export WATCH_EMAIL_TO='din@adress.se'
# valfritt: export WATCH_EMAIL_FROM='avsändare@adress.se'    # standard: samma som WATCH_EMAIL_TO
```

Utan båda variablerna skrivs samma HTML i stället till
`.planning/calibration/data/weekly-<datum>.html`, körningen säger vilken variabel som saknas och avslutar med
kod 4. Bevakningsminnet lämnas orört, så annonserna mejlas första gången variablerna fungerar (ett stavfel i
`~/.zshenv` får inte göra att veckans annonser räknas som sedda utan att någon fått dem). Vill du ändå markera
dem som sedda utan mejl, kör med `WATCH_MARK_SEEN_WITHOUT_SMTP=1`.

## Slutkoder

| Kod | Betydelse |
|---|---|
| 0 | Klart (även en tyst vecka utan nyheter) |
| 1 | Fel: argument, fil, nyckel saknas, alla distrikt misslyckades, ingen skärm |
| 2 | Booli vägrade (utmaning/403) — körningen stoppade vid första vägrade sidan, resten hoppades över, `refused weekly-live` skrevs i trafikloggen, mailet märkt "berikning avbruten (Booli)"; vänta minst ett dygn (14.5 CR-01). Samma kod för: Apify-utrymmet för månaden räcker inte (bara med `--renderer apify`) |
| 3 | En annan körning håller låset (`watch-state.lock`) |
| 4 | E-postleveransen misslyckades eller SMTP-variablerna saknas (HTML skriven, bevakningsminnet orört) |
| 5 | Körningen passerade 2 timmar och stoppades av vakthunden (webbläsaren stängdes, låset släpptes) |
