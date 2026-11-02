-- 001 Grunnmodell for tilbudsevaluering.
-- Modellen er godkjent i dokumentet «Tilbudsevaluering – datamodell og avklaringer (fase 1)».
--
-- Konvensjoner
--   * Beløp: NUMERIC(15,2) i kroner eks. mva. Mengder: NUMERIC(15,3). Aldri flyttall.
--   * Lukkede lister er TEXT med CHECK, så de kan endres i en senere migrering uten ENUM-ombygging.
--   * Felles sporingskolonner (opprettet_av/tid, endret_av/tid) settes av trigger fra app.bruker_id.
--   * Alle endringer logges per felt i endringslogg av en trigger (se nederst).
--   * Kildefelt: kilde_type, kilde_dokument_id, kilde_ref, kilde_begrunnelse.
--     «tilbud» krever dokument og referanse (side/ark), «forutsetning» krever begrunnelse.

-- ---------------------------------------------------------------------------
-- Hjelpefunksjoner
-- ---------------------------------------------------------------------------

-- «82.10» → «0082.0010». Samme regel som sorteringsnokkel() i @tilbud/beregning.
create function fag_sorteringsnokkel(nummer text) returns text
language sql immutable strict parallel safe as $$
  select string_agg(case when ledd ~ '^\d+$' then lpad(ledd, 4, '0') else ledd end, '.' order by nr)
  from unnest(string_to_array(btrim(nummer), '.')) with ordinality as t(ledd, nr)
$$;

create function gjeldende_bruker() returns uuid
language sql stable as $$
  select nullif(current_setting('app.bruker_id', true), '')::uuid
$$;

-- ---------------------------------------------------------------------------
-- Grunndata
-- ---------------------------------------------------------------------------

create table bruker (
  id               uuid primary key default gen_random_uuid(),
  navn             text not null,
  epost            text not null unique,
  entra_objekt_id  text unique,
  aktiv            boolean not null default true,
  opprettet_av     uuid references bruker(id),
  opprettet_tid    timestamptz not null default now(),
  endret_av        uuid references bruker(id),
  endret_tid       timestamptz not null default now()
);

create table prosjekt (
  id                      uuid primary key default gen_random_uuid(),
  nummer                  text not null unique,
  navn                    text not null,
  byggherre               text,
  kontraktsform           text check (kontraktsform in ('NS 8407', 'NS 8405', 'annet')),
  bta_m2                  numeric(12,2) check (bta_m2 > 0),
  byggtype                text,
  tilbudsfrist_bh         timestamptz,
  vedstaelse_bh_til       date,
  forventet_kontraktsdato date,
  status                  text not null default 'kalkulasjon'
                          check (status in ('kalkulasjon', 'levert', 'vunnet', 'tapt', 'avsluttet')),
  opprettet_av            uuid references bruker(id),
  opprettet_tid           timestamptz not null default now(),
  endret_av               uuid references bruker(id),
  endret_tid              timestamptz not null default now()
);

create table fagkapittel (
  id                uuid primary key default gen_random_uuid(),
  nummer            text not null unique,
  navn              text not null,
  overordnet_id     uuid references fagkapittel(id),
  sorteringsnokkel  text generated always as (fag_sorteringsnokkel(nummer)) stored,
  standard_mal      text check (standard_mal in ('A', 'B', 'C', 'D')),
  aktiv             boolean not null default true,
  opprettet_av      uuid references bruker(id),
  opprettet_tid     timestamptz not null default now(),
  endret_av         uuid references bruker(id),
  endret_tid        timestamptz not null default now()
);
create index on fagkapittel (sorteringsnokkel, nummer);

create table bygningsdel (
  id             uuid primary key default gen_random_uuid(),
  kode           text not null unique,
  navn           text not null,
  overordnet_id  uuid references bygningsdel(id),
  opprettet_av   uuid references bruker(id),
  opprettet_tid  timestamptz not null default now(),
  endret_av      uuid references bruker(id),
  endret_tid     timestamptz not null default now()
);

create table fagkapittel_bygningsdel (
  fagkapittel_id  uuid not null references fagkapittel(id) on delete cascade,
  bygningsdel_id  uuid not null references bygningsdel(id) on delete cascade,
  primary key (fagkapittel_id, bygningsdel_id)
);

create table tilbyder (
  id              uuid primary key default gen_random_uuid(),
  firmanavn       text not null,
  orgnr           text unique check (orgnr ~ '^\d{9}$'),
  kontaktperson   text,
  epost           text,
  telefon         text,
  opprettet_av    uuid references bruker(id),
  opprettet_tid   timestamptz not null default now(),
  endret_av       uuid references bruker(id),
  endret_tid      timestamptz not null default now()
);

create table prosjekt_rolle (
  bruker_id    uuid not null references bruker(id) on delete cascade,
  prosjekt_id  uuid not null references prosjekt(id) on delete cascade,
  rolle        text not null check (rolle in ('kalkulator', 'sidemann', 'leser')),
  primary key (bruker_id, prosjekt_id, rolle)
);

-- ---------------------------------------------------------------------------
-- Forespørsler og tilbud
-- ---------------------------------------------------------------------------

-- Dokument kommer først fordi kildefeltene i andre tabeller peker hit.
-- tilbud_id legges til som fremmednøkkel når tilbud finnes (se under).
create table dokument (
  id                  uuid primary key default gen_random_uuid(),
  prosjekt_id         uuid not null references prosjekt(id) on delete cascade,
  tilbud_id           uuid,
  filnavn             text not null,
  filtype             text,
  storrelse_byte      bigint,
  sha256              text,
  lagringstype        text not null default 'lokal' check (lagringstype in ('lokal', 'sharepoint')),
  lagringsnokkel      text not null,
  sharepoint_drive_id text,
  sharepoint_item_id  text,
  mappesti            text,
  opprettet_av        uuid references bruker(id),
  opprettet_tid       timestamptz not null default now(),
  endret_av           uuid references bruker(id),
  endret_tid          timestamptz not null default now()
);

create table prosjekt_fag (
  id                     uuid primary key default gen_random_uuid(),
  prosjekt_id            uuid not null references prosjekt(id) on delete cascade,
  fagkapittel_id         uuid not null references fagkapittel(id),
  status                 text not null default 'forespurt'
                         check (status in ('ikke_aktuell', 'forespurt', 'delvis_mottatt', 'under_evaluering',
                                           'evaluert', 'lagt_til_grunn', 'kontrahert')),
  foresporres            boolean not null default true,
  mal                    text check (mal in ('A', 'B', 'C', 'D')),
  ue_tilbudsfrist        timestamptz,
  he_anslag              numeric(15,2),
  he_anslag_kilde_type   text check (he_anslag_kilde_type in ('tilbud', 'forutsetning', 'beregnet')),
  he_anslag_begrunnelse  text,
  inkludert_i_kalkyle    boolean not null default false,
  neste_steg             text,
  ansvarlig              text,
  merknad                text,
  opprettet_av           uuid references bruker(id),
  opprettet_tid          timestamptz not null default now(),
  endret_av              uuid references bruker(id),
  endret_tid             timestamptz not null default now(),
  unique (prosjekt_id, fagkapittel_id),
  check (he_anslag is null or he_anslag_kilde_type <> 'forutsetning' or coalesce(he_anslag_begrunnelse, '') <> '')
);

create table foresporsel (
  id              uuid primary key default gen_random_uuid(),
  prosjekt_fag_id uuid not null references prosjekt_fag(id) on delete cascade,
  tilbyder_id     uuid not null references tilbyder(id),
  dato_forespurt  date,
  status          text not null default 'forespurt'
                  check (status in ('forespurt', 'tilbud_mottatt', 'regner_ikke', 'ikke_svart')),
  kommentar       text,
  opprettet_av    uuid references bruker(id),
  opprettet_tid   timestamptz not null default now(),
  endret_av       uuid references bruker(id),
  endret_tid      timestamptz not null default now(),
  unique (prosjekt_fag_id, tilbyder_id)
);

create table tilbud (
  id                 uuid primary key default gen_random_uuid(),
  foresporsel_id     uuid not null references foresporsel(id) on delete cascade,
  versjon            integer not null default 1 check (versjon >= 1),
  erstatter_id       uuid references tilbud(id),
  tilbudsnr          text,
  tilbudsdato        date,
  mottatt_tid        timestamptz not null,
  etter_frist        boolean not null default false,
  vedstaelsesfrist   date,
  tilbudssum         numeric(15,2),
  kilde_type         text check (kilde_type in ('tilbud', 'forutsetning', 'beregnet')),
  kilde_dokument_id  uuid references dokument(id),
  kilde_ref          text,
  kilde_begrunnelse  text,
  opprettet_av       uuid references bruker(id),
  opprettet_tid      timestamptz not null default now(),
  endret_av          uuid references bruker(id),
  endret_tid         timestamptz not null default now(),
  unique (foresporsel_id, versjon),
  check (tilbudssum is null or kilde_type is not null),
  check (kilde_type is distinct from 'tilbud' or (kilde_dokument_id is not null and coalesce(kilde_ref, '') <> '')),
  check (kilde_type is distinct from 'forutsetning' or coalesce(kilde_begrunnelse, '') <> '')
);

alter table dokument add foreign key (tilbud_id) references tilbud(id) on delete set null;

-- Pakketilbud: ett tilbud kan dekke flere fag. Hvert fag får sin andel med kilde.
create table tilbud_fagandel (
  id                 uuid primary key default gen_random_uuid(),
  tilbud_id          uuid not null references tilbud(id) on delete cascade,
  prosjekt_fag_id    uuid not null references prosjekt_fag(id) on delete cascade,
  belop              numeric(15,2) not null,
  kilde_type         text not null check (kilde_type in ('tilbud', 'forutsetning', 'beregnet')),
  kilde_dokument_id  uuid references dokument(id),
  kilde_ref          text,
  kilde_begrunnelse  text,
  opprettet_av       uuid references bruker(id),
  opprettet_tid      timestamptz not null default now(),
  endret_av          uuid references bruker(id),
  endret_tid         timestamptz not null default now(),
  unique (tilbud_id, prosjekt_fag_id),
  check (kilde_type <> 'tilbud' or (kilde_dokument_id is not null and coalesce(kilde_ref, '') <> '')),
  check (kilde_type <> 'forutsetning' or coalesce(kilde_begrunnelse, '') <> '')
);

create table tilbud_vilkar (
  id                 uuid primary key default gen_random_uuid(),
  tilbud_id          uuid not null references tilbud(id) on delete cascade,
  tema               text not null check (tema in ('prisregulering', 'kontraktsgrunnlag', 'betaling',
                       'timepris_fagarbeider', 'timepris_bas', 'timepris_prosjektleder', 'timepris_prosjekterende',
                       'paslag_materiell', 'service_garanti', 'seriositet', 'generelle_forbehold', 'annet')),
  tekst              text,
  belop              numeric(15,2),
  kilde_type         text not null default 'tilbud' check (kilde_type in ('tilbud', 'forutsetning', 'beregnet')),
  kilde_dokument_id  uuid references dokument(id),
  kilde_ref          text,
  kilde_begrunnelse  text,
  opprettet_av       uuid references bruker(id),
  opprettet_tid      timestamptz not null default now(),
  endret_av          uuid references bruker(id),
  endret_tid         timestamptz not null default now(),
  check (kilde_type <> 'tilbud' or (kilde_dokument_id is not null and coalesce(kilde_ref, '') <> '')),
  check (kilde_type <> 'forutsetning' or coalesce(kilde_begrunnelse, '') <> '')
);

create table tilbud_prisfordeling (
  id                 uuid primary key default gen_random_uuid(),
  tilbud_id          uuid not null references tilbud(id) on delete cascade,
  kode               text,
  beskrivelse        text not null,
  belop              numeric(15,2) not null,
  rekkefolge         integer not null default 0,
  kilde_type         text not null default 'tilbud' check (kilde_type in ('tilbud', 'forutsetning', 'beregnet')),
  kilde_dokument_id  uuid references dokument(id),
  kilde_ref          text,
  kilde_begrunnelse  text,
  opprettet_av       uuid references bruker(id),
  opprettet_tid      timestamptz not null default now(),
  endret_av          uuid references bruker(id),
  endret_tid         timestamptz not null default now(),
  check (kilde_type <> 'tilbud' or (kilde_dokument_id is not null and coalesce(kilde_ref, '') <> '')),
  check (kilde_type <> 'forutsetning' or coalesce(kilde_begrunnelse, '') <> '')
);

create table tilbud_opsjon (
  id                 uuid primary key default gen_random_uuid(),
  tilbud_id          uuid not null references tilbud(id) on delete cascade,
  tekst              text not null,
  belop              numeric(15,2),
  kilde_type         text not null default 'tilbud' check (kilde_type in ('tilbud', 'forutsetning', 'beregnet')),
  kilde_dokument_id  uuid references dokument(id),
  kilde_ref          text,
  kilde_begrunnelse  text,
  opprettet_av       uuid references bruker(id),
  opprettet_tid      timestamptz not null default now(),
  endret_av          uuid references bruker(id),
  endret_tid         timestamptz not null default now(),
  check (kilde_type <> 'tilbud' or (kilde_dokument_id is not null and coalesce(kilde_ref, '') <> '')),
  check (kilde_type <> 'forutsetning' or coalesce(kilde_begrunnelse, '') <> '')
);

-- ---------------------------------------------------------------------------
-- Evaluering (per fag og revisjon). Alt under evaluering kopieres ved ny revisjon.
-- ---------------------------------------------------------------------------

create table evaluering (
  id                       uuid primary key default gen_random_uuid(),
  prosjekt_fag_id          uuid not null references prosjekt_fag(id) on delete cascade,
  revisjon                 integer not null default 1 check (revisjon >= 1),
  mal                      text not null check (mal in ('A', 'B', 'C')),
  status                   text not null default 'under_evaluering'
                           check (status in ('under_evaluering', 'ferdig_evaluert', 'ks_godkjent')),
  laast                    boolean not null default false,
  ks_av                    uuid references bruker(id),
  ks_tid                   timestamptz,
  valgt_tilbud_id          uuid references tilbud(id),
  valgt_kombinasjon_id     uuid,
  risikotillegg            numeric(15,2) not null default 0,
  risikotillegg_begrunnelse text,
  anbefaling               text,
  storste_risikoer         text,
  opprettet_av             uuid references bruker(id),
  opprettet_tid            timestamptz not null default now(),
  endret_av                uuid references bruker(id),
  endret_tid               timestamptz not null default now(),
  unique (prosjekt_fag_id, revisjon),
  check (risikotillegg = 0 or coalesce(risikotillegg_begrunnelse, '') <> ''),
  check (valgt_tilbud_id is null or valgt_kombinasjon_id is null)
);

create table evaluering_tilbud (
  id                     uuid primary key default gen_random_uuid(),
  evaluering_id          uuid not null references evaluering(id) on delete cascade,
  tilbud_id              uuid not null references tilbud(id),
  med_i_evaluering       boolean not null default true,
  kompletthet            text check (kompletthet in ('komplett', 'mindre_mangler', 'vesentlige_mangler')),
  kompletthetsvurdering  text,
  rekkefolge             integer not null default 0,
  opprettet_av           uuid references bruker(id),
  opprettet_tid          timestamptz not null default now(),
  endret_av              uuid references bruker(id),
  endret_tid             timestamptz not null default now(),
  unique (evaluering_id, tilbud_id)
);

create table kategori (
  id             uuid primary key default gen_random_uuid(),
  evaluering_id  uuid not null references evaluering(id) on delete cascade,
  navn           text not null,
  del            smallint check (del in (1, 2, 9)),
  rekkefolge     integer not null default 0,
  opprettet_av   uuid references bruker(id),
  opprettet_tid  timestamptz not null default now(),
  endret_av      uuid references bruker(id),
  endret_tid     timestamptz not null default now()
);

create table evalpost (
  id                       uuid primary key default gen_random_uuid(),
  evaluering_id            uuid not null references evaluering(id) on delete cascade,
  kategori_id              uuid references kategori(id) on delete set null,
  postnr                   text,
  tekst                    text not null,
  enhet                    text,
  referansemengde          numeric(15,3),
  referansemengde_kilde    text,
  he_kalkpris              numeric(15,2),
  regulerbar               boolean not null default false,
  ns3451_kode              text,
  rekkefolge               integer not null default 0,
  opprettet_av             uuid references bruker(id),
  opprettet_tid            timestamptz not null default now(),
  endret_av                uuid references bruker(id),
  endret_tid               timestamptz not null default now()
);

create table tilbudspost (
  id                    uuid primary key default gen_random_uuid(),
  evaluering_tilbud_id  uuid not null references evaluering_tilbud(id) on delete cascade,
  evalpost_id           uuid references evalpost(id) on delete cascade,
  kategori_id           uuid references kategori(id) on delete set null,
  postnr                text,
  tekst                 text,
  ue_mengde             numeric(15,3),
  enhetspris            numeric(15,2),
  sum_tilbudt           numeric(15,2),
  status                text not null default 'priset' check (status in ('priset', 'inkl_annen_post', 'ikke_priset')),
  utenfor_mengdeliste   boolean not null default false,
  rekkefolge            integer not null default 0,
  kilde_type            text check (kilde_type in ('tilbud', 'forutsetning', 'beregnet')),
  kilde_dokument_id     uuid references dokument(id),
  kilde_ref             text,
  kilde_begrunnelse     text,
  opprettet_av          uuid references bruker(id),
  opprettet_tid         timestamptz not null default now(),
  endret_av             uuid references bruker(id),
  endret_tid            timestamptz not null default now(),
  check (kilde_type is distinct from 'tilbud' or (kilde_dokument_id is not null and coalesce(kilde_ref, '') <> '')),
  check (kilde_type is distinct from 'forutsetning' or coalesce(kilde_begrunnelse, '') <> '')
);

create table krav (
  id                  uuid primary key default gen_random_uuid(),
  prosjekt_id         uuid not null references prosjekt(id) on delete cascade,
  kode                text not null,
  kilde_dokument_id   uuid references dokument(id),
  kilde_kapittel      text,
  kravtype            text check (kravtype in ('kontrakt', 'seriositet', 'miljo', 'teknisk', 'dokumentasjon', 'prosess')),
  kravtekst           text not null,
  ansvarlig_kap       text,
  dekket_av_valgte_ue text,
  kalkylekonsekvens   numeric(15,2),
  tiltak              text,
  forbehold_til_bh    boolean not null default false,
  status              smallint check (status between 0 and 3),
  opprettet_av        uuid references bruker(id),
  opprettet_tid       timestamptz not null default now(),
  endret_av           uuid references bruker(id),
  endret_tid          timestamptz not null default now(),
  unique (prosjekt_id, kode)
);

create table krav_fag (
  krav_id          uuid not null references krav(id) on delete cascade,
  prosjekt_fag_id  uuid not null references prosjekt_fag(id) on delete cascade,
  primary key (krav_id, prosjekt_fag_id)
);

create table omfangspunkt (
  id             uuid primary key default gen_random_uuid(),
  evaluering_id  uuid not null references evaluering(id) on delete cascade,
  gruppe         text not null check (gruppe in ('generelt', 'hovedleveranse', 'grensesnitt', 'krav', 'opsjoner')),
  tekst          text not null,
  krav_id        uuid references krav(id) on delete set null,
  rekkefolge     integer not null default 0,
  opprettet_av   uuid references bruker(id),
  opprettet_tid  timestamptz not null default now(),
  endret_av      uuid references bruker(id),
  endret_tid     timestamptz not null default now()
);

create table omfangsvurdering (
  id                    uuid primary key default gen_random_uuid(),
  evaluering_tilbud_id  uuid not null references evaluering_tilbud(id) on delete cascade,
  omfangspunkt_id       uuid not null references omfangspunkt(id) on delete cascade,
  status                text check (status in ('inkl', 'ikke_inkl', 'uavklart', 'forbehold', 'avvik', 'andre', 'overlapp', 'ikke_relevant')),
  kommentar             text,
  kilde_type            text check (kilde_type in ('tilbud', 'forutsetning', 'beregnet')),
  kilde_dokument_id     uuid references dokument(id),
  kilde_ref             text,
  kilde_begrunnelse     text,
  opprettet_av          uuid references bruker(id),
  opprettet_tid         timestamptz not null default now(),
  endret_av             uuid references bruker(id),
  endret_tid            timestamptz not null default now(),
  unique (evaluering_tilbud_id, omfangspunkt_id),
  check (kilde_type is distinct from 'tilbud' or (kilde_dokument_id is not null and coalesce(kilde_ref, '') <> '')),
  check (kilde_type is distinct from 'forutsetning' or coalesce(kilde_begrunnelse, '') <> '')
);

create table erfaringspost (
  id                    uuid primary key default gen_random_uuid(),
  type                  text not null check (type in ('nokkeltall', 'enhetspris', 'anslag', 'typisk_hull', 'ue_erfaring')),
  fagkapittel           text,
  bygningsdel_kode      text,
  prosjekt_id           uuid references prosjekt(id),
  dato                  date not null,
  verdi                 numeric(15,2),
  enhet                 text,
  inkluderer            text,
  kilde                 text check (kilde in ('tilbud', 'he_kalkpris', 'anslag')),
  byggtype              text,
  bta_m2                numeric(12,2),
  indeksserie           text,
  indeksperiode         text,
  tekst                 text,
  tilbyder_id           uuid references tilbyder(id),
  vurdering             text check (vurdering in ('positiv', 'positiv_med_forbehold', 'noytral', 'negativ')),
  levert_innen_frist    boolean,
  kilde_evaluering_id   uuid,
  bekreftet_av          uuid references bruker(id),
  bekreftet_tid         timestamptz,
  opprettet_av          uuid references bruker(id),
  opprettet_tid         timestamptz not null default now(),
  endret_av             uuid references bruker(id),
  endret_tid            timestamptz not null default now()
);

create table forutsetning (
  id                     uuid primary key default gen_random_uuid(),
  evaluering_id          uuid not null references evaluering(id) on delete cascade,
  nr                     integer not null,
  tekst                  text not null,
  mengde                 numeric(15,3),
  enhet                  text,
  enhetspris             numeric(15,2),
  belop                  numeric(15,2) not null,
  grunnlag               text not null check (btrim(grunnlag) <> ''),
  erfaringspost_id       uuid references erfaringspost(id),
  grensesnittjustering_id uuid,
  opprettet_av           uuid references bruker(id),
  opprettet_tid          timestamptz not null default now(),
  endret_av              uuid references bruker(id),
  endret_tid             timestamptz not null default now(),
  unique (evaluering_id, nr)
);

create table justering (
  id                    uuid primary key default gen_random_uuid(),
  evaluering_tilbud_id  uuid not null references evaluering_tilbud(id) on delete cascade,
  type                  text not null check (type in ('mangler', 'uavklart', 'forbehold', 'overlapp')),
  forutsetning_id       uuid references forutsetning(id) on delete restrict,
  tilbudspost_id        uuid references tilbudspost(id) on delete restrict,
  omfangspunkt_id       uuid references omfangspunkt(id) on delete set null,
  kategori_id           uuid references kategori(id) on delete set null,
  overlapp_fag_id       uuid references fagkapittel(id),
  fortegn               smallint not null default 1 check (fortegn in (1, -1)),
  faktor                numeric(7,4) not null default 1 check (faktor > 0),
  begrunnelse           text,
  opprettet_av          uuid references bruker(id),
  opprettet_tid         timestamptz not null default now(),
  endret_av             uuid references bruker(id),
  endret_tid            timestamptz not null default now(),
  -- Beløpet hentes alltid fra et felles anslag eller fra tilbudets egen post, aldri et fritt tall.
  check ((forutsetning_id is null) <> (tilbudspost_id is null)),
  check (faktor = 1 or coalesce(begrunnelse, '') <> ''),
  check (type <> 'overlapp' or overlapp_fag_id is not null)
);

create table kombinasjon (
  id                uuid primary key default gen_random_uuid(),
  evaluering_id     uuid not null references evaluering(id) on delete cascade,
  nr                integer not null,
  tilbud_del1_id    uuid references tilbud(id),
  tilbud_del2_id    uuid references tilbud(id),
  forutsetning_id   uuid references forutsetning(id),
  merknad           text,
  opprettet_av      uuid references bruker(id),
  opprettet_tid     timestamptz not null default now(),
  endret_av         uuid references bruker(id),
  endret_tid        timestamptz not null default now(),
  unique (evaluering_id, nr)
);

alter table evaluering add foreign key (valgt_kombinasjon_id) references kombinasjon(id) on delete set null;

create table varsel_kvittering (
  id                    uuid primary key default gen_random_uuid(),
  evaluering_tilbud_id  uuid not null references evaluering_tilbud(id) on delete cascade,
  varseltype            text not null,
  kommentar             text not null,
  opprettet_av          uuid references bruker(id),
  opprettet_tid         timestamptz not null default now(),
  endret_av             uuid references bruker(id),
  endret_tid            timestamptz not null default now(),
  unique (evaluering_tilbud_id, varseltype)
);

create table evaluering_resultat (
  id             uuid primary key default gen_random_uuid(),
  evaluering_id  uuid not null references evaluering(id) on delete cascade,
  hendelse       text not null check (hendelse in ('ferdig_evaluert', 'ks_godkjent', 'eksport')),
  resultat       jsonb not null,
  opprettet_av   uuid references bruker(id),
  opprettet_tid  timestamptz not null default now(),
  endret_av      uuid references bruker(id),
  endret_tid     timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Forbehold og avklaringer
-- ---------------------------------------------------------------------------

create table forbehold (
  id                 uuid primary key default gen_random_uuid(),
  prosjekt_id        uuid not null references prosjekt(id) on delete cascade,
  prosjekt_fag_id    uuid references prosjekt_fag(id) on delete cascade,
  tilbud_id          uuid references tilbud(id) on delete cascade,
  nr                 integer,
  type               text not null default 'forbehold' check (type in ('forbehold', 'forutsetning', 'sporsmal')),
  tekst              text not null,
  kategori           text check (kategori in ('detaljprosjektering', 'seriositet', 'fremdrift', 'pris', 'omfang', 'kontrakt', 'annet')),
  konsekvens         text,
  justering_id       uuid references justering(id) on delete set null,
  tiltak             text,
  status             smallint not null default 2 check (status between 0 and 3),
  vesentlig          boolean not null default false,
  ansvarlig          text,
  frist              date,
  kilde_type         text check (kilde_type in ('tilbud', 'forutsetning', 'beregnet')),
  kilde_dokument_id  uuid references dokument(id),
  kilde_ref          text,
  kilde_begrunnelse  text,
  opprettet_av       uuid references bruker(id),
  opprettet_tid      timestamptz not null default now(),
  endret_av          uuid references bruker(id),
  endret_tid         timestamptz not null default now(),
  check (kilde_type is distinct from 'tilbud' or (kilde_dokument_id is not null and coalesce(kilde_ref, '') <> '')),
  check (kilde_type is distinct from 'forutsetning' or coalesce(kilde_begrunnelse, '') <> '')
);

create table avklaring (
  id                 uuid primary key default gen_random_uuid(),
  prosjekt_id        uuid not null references prosjekt(id) on delete cascade,
  prosjekt_fag_id    uuid references prosjekt_fag(id) on delete cascade,
  tilbud_id          uuid references tilbud(id) on delete cascade,
  nr                 integer,
  tema               text,
  sporsmal           text not null,
  konsekvens         text,
  status             text not null default 'apen' check (status in ('apen', 'sendt', 'besvart', 'lukket')),
  sendt_dato         date,
  svar               text,
  svardato           date,
  kilde_dokument_id  uuid references dokument(id),
  kilde_ref          text,
  opprettet_av       uuid references bruker(id),
  opprettet_tid      timestamptz not null default now(),
  endret_av          uuid references bruker(id),
  endret_tid         timestamptz not null default now()
);

create table bh_forbehold (
  id             uuid primary key default gen_random_uuid(),
  prosjekt_id    uuid not null references prosjekt(id) on delete cascade,
  tekst          text not null,
  forbehold_id   uuid references forbehold(id) on delete set null,
  krav_id        uuid references krav(id) on delete set null,
  avklaring_id   uuid references avklaring(id) on delete set null,
  status         text not null default 'utkast' check (status in ('utkast', 'tatt_med', 'forkastet')),
  opprettet_av   uuid references bruker(id),
  opprettet_tid  timestamptz not null default now(),
  endret_av      uuid references bruker(id),
  endret_tid     timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Grensesnitt (mal D)
-- ---------------------------------------------------------------------------

create table grensesnittpunkt (
  id               uuid primary key default gen_random_uuid(),
  prosjekt_id      uuid not null references prosjekt(id) on delete cascade,
  kode             text not null,
  gruppe           text,
  fag              text,
  komponent        text not null,
  krav_id          uuid references krav(id) on delete set null,
  status           text check (status in ('dekket', 'dekket_i_kalkyle', 'overlapp', 'dobbelt_i_kalkyle',
                                          'konflikt', 'avvik', 'uavklart', 'hull')),
  anbefalt_ansvar  text,
  tiltak           text,
  rekkefolge       integer not null default 0,
  opprettet_av     uuid references bruker(id),
  opprettet_tid    timestamptz not null default now(),
  endret_av        uuid references bruker(id),
  endret_tid       timestamptz not null default now(),
  unique (prosjekt_id, kode)
);

create table grensesnittleveranse (
  id                   uuid primary key default gen_random_uuid(),
  grensesnittpunkt_id  uuid not null references grensesnittpunkt(id) on delete cascade,
  prosjekt_fag_id      uuid not null references prosjekt_fag(id) on delete cascade,
  tekst                text,
  kilde_type           text check (kilde_type in ('tilbud', 'forutsetning', 'beregnet')),
  kilde_dokument_id    uuid references dokument(id),
  kilde_ref            text,
  kilde_begrunnelse    text,
  opprettet_av         uuid references bruker(id),
  opprettet_tid        timestamptz not null default now(),
  endret_av            uuid references bruker(id),
  endret_tid           timestamptz not null default now(),
  unique (grensesnittpunkt_id, prosjekt_fag_id),
  check (kilde_type is distinct from 'tilbud' or (kilde_dokument_id is not null and coalesce(kilde_ref, '') <> '')),
  check (kilde_type is distinct from 'forutsetning' or coalesce(kilde_begrunnelse, '') <> '')
);

create table grensesnittjustering (
  id                   uuid primary key default gen_random_uuid(),
  prosjekt_id          uuid not null references prosjekt(id) on delete cascade,
  nr                   integer not null,
  grensesnittpunkt_id  uuid references grensesnittpunkt(id) on delete set null,
  beskrivelse          text not null,
  belop                numeric(15,2) not null,
  grunnlag             text not null check (btrim(grunnlag) <> ''),
  opprettet_av         uuid references bruker(id),
  opprettet_tid        timestamptz not null default now(),
  endret_av            uuid references bruker(id),
  endret_tid           timestamptz not null default now(),
  unique (prosjekt_id, nr)
);

-- Delt post («41/56»): fordeling i % per fag. Summen skal være 100.
create table grensesnittjustering_fag (
  grensesnittjustering_id  uuid not null references grensesnittjustering(id) on delete cascade,
  prosjekt_fag_id          uuid not null references prosjekt_fag(id) on delete cascade,
  andel_prosent            numeric(5,2) not null default 100 check (andel_prosent > 0 and andel_prosent <= 100),
  primary key (grensesnittjustering_id, prosjekt_fag_id)
);

alter table forutsetning add foreign key (grensesnittjustering_id) references grensesnittjustering(id) on delete set null;
alter table erfaringspost add foreign key (kilde_evaluering_id) references evaluering(id) on delete set null;

-- ---------------------------------------------------------------------------
-- Indeks og endringslogg
-- ---------------------------------------------------------------------------

create table indeks (
  id             uuid primary key default gen_random_uuid(),
  serie          text not null,
  periode        text not null check (periode ~ '^\d{4}-\d{2}$'),
  verdi          numeric(10,2) not null,
  opprettet_av   uuid references bruker(id),
  opprettet_tid  timestamptz not null default now(),
  endret_av      uuid references bruker(id),
  endret_tid     timestamptz not null default now(),
  unique (serie, periode)
);

create table endringslogg (
  id         bigint generated always as identity primary key,
  tabell     text not null,
  rad_id     text not null,
  handling   text not null check (handling in ('ny', 'endret', 'slettet')),
  felt       text,
  gammel     jsonb,
  ny         jsonb,
  bruker_id  uuid,
  tidspunkt  timestamptz not null default now()
);
create index on endringslogg (tabell, rad_id, tidspunkt);

-- Endringsloggen skal ikke kunne endres eller slettes.
create function endringslogg_skrivebeskyttet() returns trigger language plpgsql as $$
begin
  raise exception 'Endringsloggen kan ikke endres eller slettes';
end $$;
create trigger endringslogg_skrivebeskyttet before update or delete on endringslogg
  for each row execute function endringslogg_skrivebeskyttet();

-- Setter opprettet_av/endret_av og endret_tid.
create function sett_sporing() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    new.opprettet_av := coalesce(new.opprettet_av, gjeldende_bruker());
    new.opprettet_tid := coalesce(new.opprettet_tid, now());
  else
    new.opprettet_av := old.opprettet_av;
    new.opprettet_tid := old.opprettet_tid;
  end if;
  new.endret_av := gjeldende_bruker();
  new.endret_tid := now();
  return new;
end $$;

-- Logger ny rad, hvert endrede felt og slettet rad.
create function logg_endring() returns trigger language plpgsql as $$
declare
  gml jsonb;
  nye jsonb;
  felt text;
  ignorer constant text[] := array['endret_av', 'endret_tid', 'opprettet_av', 'opprettet_tid'];
  rad text;
begin
  if tg_op = 'INSERT' then
    nye := to_jsonb(new);
    rad := coalesce(nye->>'id', nye::text);
    insert into endringslogg (tabell, rad_id, handling, ny, bruker_id)
    values (tg_table_name, rad, 'ny', nye, gjeldende_bruker());
    return new;
  elsif tg_op = 'UPDATE' then
    gml := to_jsonb(old);
    nye := to_jsonb(new);
    rad := coalesce(nye->>'id', nye::text);
    for felt in select jsonb_object_keys(nye) loop
      if not felt = any(ignorer) and (gml->felt) is distinct from (nye->felt) then
        insert into endringslogg (tabell, rad_id, handling, felt, gammel, ny, bruker_id)
        values (tg_table_name, rad, 'endret', felt, gml->felt, nye->felt, gjeldende_bruker());
      end if;
    end loop;
    return new;
  else
    gml := to_jsonb(old);
    rad := coalesce(gml->>'id', gml::text);
    insert into endringslogg (tabell, rad_id, handling, gammel, bruker_id)
    values (tg_table_name, rad, 'slettet', gml, gjeldende_bruker());
    return old;
  end if;
end $$;

-- Koble triggerne på alle tabeller. Koblingstabeller uten sporingskolonner får bare logging.
do $$
declare
  t record;
begin
  for t in
    select c.relname as navn,
           exists (select 1 from information_schema.columns k
                   where k.table_schema = 'public' and k.table_name = c.relname and k.column_name = 'endret_tid') as har_sporing
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
      and c.relname not in ('endringslogg', 'skjema_migrering')
  loop
    if t.har_sporing then
      execute format('create trigger sett_sporing before insert or update on %I for each row execute function sett_sporing()', t.navn);
    end if;
    execute format('create trigger logg_endring after insert or update or delete on %I for each row execute function logg_endring()', t.navn);
  end loop;
end $$;
