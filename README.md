# Tilbudsevaluering

Webapp for kalkulasjonsavdelingen: evaluering av tilbud fra underentreprenører (UE) og leverandører per fagkapittel. Den erstatter Excel-malene A–D, samlearket og erfaringsregisteret.

Grunnreglene er at presisjon og sporbarhet går foran «smart» oppførsel:

- **Beløp er aldri flyttall.** De lagres som `NUMERIC` i Postgres, sendes som tekst i API-et og regnes med `decimal.js`.
- **Hvert tall har en kilde.** Blått betyr at tallet er hentet fra tilbudet, med dokument og side. Gult betyr kalkulatorisk forutsetning, med begrunnelse. Svart betyr beregnet. Databasen avviser tall som mangler kilde eller begrunnelse.
- **Ingen frie beløp i justeringer.** En justering peker alltid på en felles forutsetning eller på en post i tilbudet, ganget med en faktor. Annen faktor enn 1 krever begrunnelse.
- **Alt logges.** Hver endring i hver tabell skrives til `endringslogg` med bruker og tidspunkt. Loggen kan ikke endres.

## Hva fase 2 (MVP) dekker

Arbeidsflyten er prosjekt → fagkapitler → forespørsler og tilbud → evaluering etter mal B → sammendrag → Excel-eksport.

- **Prosjektoversikt** (samlearket): status per fag, HE-anslag, valgt UE og beløp til kalkyle. Sum UE-kost og kr/m² BTA vises nederst. Har både et hovedkapittel og et underkapittel beløp, telles bare underkapitlene, og appen varsler om det.
- **Fagkapitler:** import fra Excel (arket «Fagkapitler»). Appen advarer når nummer er lagret som tall, f.eks. 82.1 som skulle vært 82.10.
- **Forespørsler og tilbud:**
  - Tilbudsdokumentene lastes opp og lagres i mappestrukturen `<prosjektnr>/4 Mottatte tilbud/<kap> <UE>/`.
  - Tilbud mottatt etter fristen merkes automatisk.
  - Et revidert tilbud blir ny versjon. Det arver merket «etter frist» og erstatter forrige versjon i åpne evalueringer.
- **Evaluering mal B:**
  - Sammendrag med evaluert sum, rangering (samme regel som `RANK` i Excel), differanse mot laveste og kr/m².
  - Kontroll av prisfordelingen mot tilbudssummen. Den gjøres bare når tilbudet har prisfordeling.
  - Felles forutsetninger × tilbydere, med faktor per celle.
  - Omfangssjekkliste med status per tilbyder.
  - Forbeholdsregister.
  - Valgt UE (standard er laveste evaluerte), risikotillegg med begrunnelse, og avvik mot HE-anslaget.
  - Risikoflagg: etter frist, kort vedståelse, laveste tilbud med åpne punkter, forbehold om detaljprosjektering og seriøsitet.
  - «Ferdig evaluert» blokkeres når et tilbud mangler sum eller kontrollen ikke går opp.
- **Excel-eksport** i samme layout som «Tilbudssammendrag» (A1:L65 med lenkerad 65). Arkene «Forutsetninger» og «Justeringer» er med for sporbarhet.
- **Rutenett** (AG Grid) der du kan lime inn fra Excel med Ctrl+V og kopiere med Ctrl+C.

## Kjøre lokalt

Du trenger Node.js 20 eller nyere og PostgreSQL 14 eller nyere.

```bash
# 1. Database
createdb tilbudsevaluering

# 2. Innstillinger
cp apps/server/.env.eksempel apps/server/.env
#    Rediger DATABASE_URL i apps/server/.env hvis nødvendig

# 3. Avhengigheter, tabeller og eksempeldata
npm install
npm run db:migrer
npm run db:seed        # fiktivt prosjekt 26-900 med 17.1 Taktekking og fire tilbydere

# 4. Start (i to terminaler)
npm run dev:server     # API på http://127.0.0.1:3001
npm run dev:web        # nettside på http://localhost:5173
```

Eksempeldataene inneholder fire tilbydere til 17.1 Taktekking. Én leverte etter fristen, og én har forbehold om endringer fra detaljprosjekteringen. En femte tilbyder regner ikke. Alle navn er fiktive.

**Innlogging i utvikling:** Appen bruker brukeren i `DEV_BRUKER_EPOST`. Klikk «bytt» øverst til høyre for å bytte, f.eks. til `sidemann@eksempel.no`. Innloggingen er et utbyttbart lag (`apps/server/src/auth.ts`), så Entra ID kan settes inn uten å endre resten.

### Tester

```bash
npm test -w packages/beregning                  # beregningsregler (ingen database)

createdb tilbud_test
TEST_DATABASE_URL=postgres://localhost/tilbud_test npm test -w apps/server   # API mot ekte Postgres
```

Testene for beregningsmodulen bruker taktekking-eksempelet med kjente fasitsvar:

| Tilbyder | Evaluert sum | Rangering |
| --- | ---: | ---: |
| Membranteknikk | 2 405 000 | 1 |
| Nordtak | 2 465 000 | 2 |
| Takservice | 2 482 000 | 3 |
| Fjellstad | 2 520 000 | 4 |

Testene dekker også kontroll mot prisfordeling, faktor 0,5, overlapp, likhet i rangering og tolking av norske tall.

## Oppbygning

```
packages/beregning   Ren TypeScript uten database: tall, fagnummer-sortering, mal B, sammendrag, varsler. Brukes av både server og nettside.
apps/server          Fastify + PostgreSQL. SQL-migreringer i db/migrations, seed i db/seed.ts, Excel-import/-eksport med ExcelJS.
apps/web             React + AG Grid Community. Sider: prosjekter, prosjektoversikt, fag (forespørsler/tilbud), evaluering.
```

- **Datamodell:** se `apps/server/db/migrations/001_grunnmodell.sql` og datamodell-dokumentet fra fase 1. Kapittelnumre er tekst («05.1», «82.10»), og sortering skjer med en generert nøkkel slik at 82.10 kommer etter 82.9.
- **Dokumentlagring** går via grensesnittet `DokumentLagring` (`apps/server/src/lagring.ts`). Foreløpig lagres filene lokalt. SharePoint kan legges til som en ny implementasjon med samme mappestruktur, siden mappesti og hash allerede lagres per dokument.
- **Låsing:** en KS-godkjent evaluering er låst i databasen. Endringer etter KS skal gi ny revisjon, og det kommer i fase 4.

## Neste faser

| Fase | Innhold |
| --- | --- |
| 3 | Mal A (mengdebeskrivelse/poster) og mal C (del 1/2/9, kombinasjoner), kravmatrise, flere risikoflagg |
| 4 | Prosjektoversikt med filtre, KS-flyt med sidemann, låsing og revisjoner |
| 5 | Erfaringsregister (enhetspriser og erfaringer på tvers av prosjekter) |
| 6 | Mal D, SharePoint-lagring og AI-uttrekk av tilbudsdata (alltid med kontroll av kalkulator) |
