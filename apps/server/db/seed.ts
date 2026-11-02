/**
 * Seed-data: et fiktivt prosjekt med fag «17.1 Taktekking» og fire tilbydere.
 *   - Fjellstad Tak AS leverer etter fristen.
 *   - Takservice Øst AS er lavest i brevet, har forbehold om detaljprosjektering og mangler mest.
 *   - Membranteknikk AS blir laveste evaluerte etter justering.
 * Tallene er de samme som i packages/beregning/test/eksempel.ts, så testene og seed-dataene stemmer.
 *
 * Kjør: npm run db:seed (fra rotmappen). Kjører ikke på nytt hvis prosjektet finnes.
 */
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { byggApp } from '../src/app.js';
import { config } from '../src/config.js';
import { type Db, en, lagPool } from '../src/db.js';
import { type DokumentLagring, LokalLagring } from '../src/lagring.js';
import { migrer } from '../src/migrer.js';

export const PROSJEKTNR = '26-900';
export const KALKULATOR = 'kalkulator@eksempel.no';

/** Utdrag av kapittellisten i Tilbudssammendrag-malen. */
const FAGKAPITLER: [string, string, string | null][] = [
  ['01', 'Rigg og drift', null],
  ['03', 'Grunn- og utomhusarbeider', 'C'],
  ['05', 'Betongarbeider', 'A'],
  ['05.1', 'Betongarbeider', 'A'],
  ['05.3', 'Armering', 'A'],
  ['08.2', 'KLT – massivtre', 'B'],
  ['10', 'Flisarbeider', 'A'],
  ['14.1', 'Vinduer', 'B'],
  ['17.1', 'Tekkearbeider', 'B'],
  ['18', 'Blikkenslagerarbeider', 'B'],
  ['21', 'Malerarbeider', 'A'],
  ['31', 'Rørleggerarbeider', 'B'],
  ['36', 'Ventilasjonsarbeider', 'B'],
  ['41', 'Elkraftarbeider', 'B'],
  ['56', 'Automatikk / SD', 'B'],
  ['82.9', 'LARK – landskap', null],
  ['82.10', 'RIM – miljø og bærekraft', null],
];

/** Liten, gyldig PDF med én linje tekst, så dokumentlenkene virker i demoen. */
function lagPdf(tekst: string): Buffer {
  const strom = `BT /F1 12 Tf 50 780 Td (${tekst.replace(/[()\\]/g, '')}) Tj ET`;
  const objekter = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${strom.length} >>\nstream\n${strom}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const pos: number[] = [];
  objekter.forEach((o, i) => {
    pos.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objekter.length + 1}\n0000000000 65535 f \n`;
  for (const p of pos) pdf += `${String(p).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objekter.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

export async function seedEksempel(db: Db, app: FastifyInstance, lagring: DokumentLagring): Promise<{ evalueringId: string; prosjektId: string } | null> {
  if (await en(db, 'select 1 from prosjekt where nummer = $1', [PROSJEKTNR])) return null;

  await db.query(
    `insert into bruker (navn, epost) values ('Kari Kalkulatør', $1), ('Sidemann Sverre', 'sidemann@eksempel.no')
     on conflict (epost) do nothing`,
    [KALKULATOR],
  );
  const bruker = (await en<{ id: string }>(db, 'select id from bruker where epost = $1', [KALKULATOR]))!;

  const api = async <T = any>(metode: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, body?: unknown): Promise<T> => {
    const r = await app.inject({ method: metode, url, payload: body as never, headers: { 'x-bruker-epost': KALKULATOR } });
    if (r.statusCode >= 400) throw new Error(`${metode} ${url} feilet (${r.statusCode}): ${r.body}`);
    return r.json() as T;
  };

  for (const [nummer, navn, mal] of FAGKAPITLER) {
    if (!(await en(db, 'select 1 from fagkapittel where nummer = $1', [nummer]))) {
      await api('POST', '/api/fagkapitler', { nummer, navn, standardMal: mal });
    }
  }
  const fag = await api<{ id: string; nummer: string }[]>('GET', '/api/fagkapitler');
  const fagId = (nr: string) => fag.find((f) => f.nummer === nr)!.id;

  const prosjekt = await api('POST', '/api/prosjekter', {
    nummer: PROSJEKTNR,
    navn: 'Eksempelveien skole',
    byggherre: 'Eksempel kommune',
    kontraktsform: 'NS 8407',
    btaM2: '3450',
    byggtype: 'Skole, massivtre',
    tilbudsfristBh: '2026-12-01T12:00:00+01:00',
    forventetKontraktsdato: '2027-01-15',
  });
  await api('POST', `/api/prosjekter/${prosjekt.id}/fag`, {
    fagkapittelIder: ['01', '03', '05.1', '08.2', '17.1', '18', '31', '36', '41', '56'].map(fagId),
  });
  const oversikt = await api('GET', `/api/prosjekter/${prosjekt.id}/oversikt`);
  const pfId = (nr: string) => oversikt.fag.find((f: { nummer: string }) => f.nummer === nr).id;
  const tak = pfId('17.1');

  await api('PATCH', `/api/prosjekt-fag/${tak}`, {
    ueTilbudsfrist: '2026-11-10T12:00:00+01:00',
    heAnslag: '2300000.00',
    heAnslagBegrunnelse: 'Erfaringstall 667 kr/m² BTA × 3 450 m²',
    inkludertIKalkyle: true,
    nesteSteg: 'Avklare fallsikring med Nordtak og Takservice',
    ansvarlig: 'Kari',
  });
  await api('PATCH', `/api/prosjekt-fag/${pfId('18')}`, { status: 'forespurt' });

  const tilbydere = [
    { firmanavn: 'Nordtak AS', kontaktperson: 'Ola Nord' },
    { firmanavn: 'Takservice Øst AS', kontaktperson: 'Per Øst' },
    { firmanavn: 'Fjellstad Tak AS', kontaktperson: 'Anne Fjellstad' },
    { firmanavn: 'Membranteknikk AS', kontaktperson: 'Lise Membran' },
    { firmanavn: 'Taktekker Vest AS', kontaktperson: 'Jon Vest' },
  ];
  const ty: Record<string, string> = {};
  for (const t of tilbydere) ty[t.firmanavn] = (await api('POST', '/api/tilbydere', t)).id;

  const fo: Record<string, string> = {};
  for (const navn of Object.keys(ty)) {
    fo[navn] = (await api('POST', `/api/prosjekt-fag/${tak}/foresporsler`, { tilbyderId: ty[navn], datoForespurt: '2026-10-20' })).id;
  }
  await api('PATCH', `/api/foresporsler/${fo['Taktekker Vest AS']}`, { status: 'regner_ikke', kommentar: 'Har ikke kapasitet før sommeren 2027' });

  const mottak: [string, string, string, string, string | null][] = [
    ['Nordtak AS', '2026-11-09T14:30:00+01:00', 'NT-2611', '2380000.00', '2027-02-15'],
    ['Takservice Øst AS', '2026-11-10T09:12:00+01:00', '4471', '2295000.00', '2027-03-01'],
    ['Fjellstad Tak AS', '2026-11-11T08:05:00+01:00', 'FT 26/118', '2520000.00', '2027-02-28'],
    ['Membranteknikk AS', '2026-11-10T11:40:00+01:00', 'MT-0931', '2410000.00', '2027-01-10'],
  ];
  const tilbudId: Record<string, string> = {};
  for (const [navn, mottatt, nr, sum, vedst] of mottak) {
    const t = await api('POST', `/api/foresporsler/${fo[navn]}/tilbud`, {
      mottattTid: mottatt,
      tilbudsnr: nr,
      tilbudsdato: mottatt.slice(0, 10),
      vedstaelsesfrist: vedst,
    });
    tilbudId[navn] = t.id;
    const filnavn = `Tilbud ${nr.replace('/', '-')} ${navn}.pdf`;
    const l = await lagring.lagre({ prosjektnr: PROSJEKTNR, kapittel: '17.1', tilbyder: navn, filnavn, innhold: lagPdf(`Tilbud ${nr} fra ${navn}: kr ${sum} eks. mva.`) });
    const dok = await en<{ id: string }>(
      db,
      `insert into dokument (prosjekt_id, tilbud_id, filnavn, filtype, storrelse_byte, sha256, lagringstype, lagringsnokkel, mappesti, opprettet_av)
       values ($1,$2,$3,'application/pdf',$4,$5,'lokal',$6,$7,$8) returning id`,
      [prosjekt.id, t.id, filnavn, l.storrelse, l.sha256, l.lagringsnokkel, l.mappesti, bruker.id],
    );
    await api('PATCH', `/api/tilbud/${t.id}`, { tilbudssum: sum, kildeType: 'tilbud', kildeDokumentId: dok!.id, kildeRef: 's. 1, tilbudsbrev' });
    if (navn === 'Nordtak AS') {
      await api('PUT', `/api/tilbud/${t.id}/prisfordeling`, [
        { kode: '263', beskrivelse: 'Taktekking og isolasjon', belop: '1650000.00', kildeType: 'tilbud', kildeDokumentId: dok!.id, kildeRef: 's. 2' },
        { kode: '264', beskrivelse: 'Takavvanning og sluk', belop: '480000.00', kildeType: 'tilbud', kildeDokumentId: dok!.id, kildeRef: 's. 2' },
        { kode: '269', beskrivelse: 'Rigg og drift', belop: '250000.00', kildeType: 'tilbud', kildeDokumentId: dok!.id, kildeRef: 's. 2' },
      ]);
    }
  }

  const ev = await api('POST', `/api/prosjekt-fag/${tak}/evalueringer`, { mal: 'B' });
  const evData = await api('GET', `/api/evalueringer/${ev.id}`);
  const et = (navn: string) => evData.tilbud.find((t: { tilbyder: string }) => t.tilbyder === navn).evaluering_tilbud_id;
  const punkt = (start: string) => evData.omfangspunkter.find((p: { tekst: string }) => p.tekst.startsWith(start)).id;

  const f1 = await api('POST', `/api/evalueringer/${ev.id}/forutsetninger`, {
    tekst: 'Fallsikring og sikkerhetsnett',
    belop: '85000.00',
    grunnlag: 'Anslag: rekkverk langs takkant 230 lm og nett over lysgårder, 4 uker',
  });
  const f2 = await api('POST', `/api/evalueringer/${ev.id}/forutsetninger`, {
    tekst: 'Tilkobling taksluk og nedløp',
    belop: '42000.00',
    grunnlag: '14 sluk à 3 000 kr, HE kalk.pris',
  });
  const f3 = await api('POST', `/api/evalueringer/${ev.id}/forutsetninger`, {
    tekst: 'Kran og heising av materialer',
    belop: '60000.00',
    grunnlag: 'Mobilkran 4 dager à 15 000 kr',
  });

  const kranPunkt = punkt('Kran, heising');
  await api('POST', `/api/evaluering-tilbud/${et('Nordtak AS')}/justeringer`, { type: 'mangler', forutsetningId: f1.id, omfangspunktId: punkt('Rigg og drift') });
  for (const f of [f1, f2, f3]) {
    await api('POST', `/api/evaluering-tilbud/${et('Takservice Øst AS')}/justeringer`, { type: 'mangler', forutsetningId: f.id });
  }
  await api('POST', `/api/evaluering-tilbud/${et('Membranteknikk AS')}/justeringer`, {
    type: 'uavklart',
    forutsetningId: f3.id,
    omfangspunktId: kranPunkt,
    faktor: '0.5',
    begrunnelse: 'Tilbudet har heising av takelementer, men ikke av isolasjon og membran',
  });

  // Overlapp: Membranteknikk har priset beslag som hører til 18 Blikkenslager. Fradraget er tilbudets egen post.
  const dokMembran = await en<{ id: string }>(db, 'select id from dokument where tilbud_id = $1', [tilbudId['Membranteknikk AS']]);
  const post = await en<{ id: string }>(
    db,
    `insert into tilbudspost (evaluering_tilbud_id, postnr, tekst, sum_tilbudt, kilde_type, kilde_dokument_id, kilde_ref, opprettet_av)
     values ($1, '4.2', 'Beslag og inndekning mot parapet', 35000, 'tilbud', $2, 's. 3, post 4.2', $3) returning id`,
    [et('Membranteknikk AS'), dokMembran!.id, bruker.id],
  );
  await api('POST', `/api/evaluering-tilbud/${et('Membranteknikk AS')}/justeringer`, {
    type: 'overlapp',
    tilbudspostId: post!.id,
    overlappFagId: fagId('18'),
    fortegn: -1,
    begrunnelse: 'Beslag mot parapet ligger i 18 Blikkenslager',
  });

  // Omfangssjekkliste: alle punkter vurdert for Fjellstad (komplett), noen åpne for de andre.
  for (const p of evData.omfangspunkter as { id: string; gruppe: string; tekst: string }[]) {
    if (p.gruppe === 'opsjoner') continue;
    for (const navn of ['Nordtak AS', 'Takservice Øst AS', 'Fjellstad Tak AS', 'Membranteknikk AS']) {
      let status = 'inkl';
      if (p.gruppe === 'grensesnitt') status = 'ikke_relevant';
      if (navn === 'Nordtak AS' && p.tekst.startsWith('Rigg og drift')) status = 'ikke_inkl';
      if (navn === 'Takservice Øst AS' && (p.tekst.startsWith('Rigg og drift') || p.tekst.startsWith('Kran') || p.tekst.startsWith('Prosjektering'))) status = 'forbehold';
      if (navn === 'Membranteknikk AS' && p.tekst.startsWith('Kran')) status = 'uavklart';
      await api('PUT', '/api/omfangsvurderinger', { evalueringTilbudId: et(navn), omfangspunktId: p.id, status });
    }
  }

  await api('PATCH', `/api/evaluering-tilbud/${et('Fjellstad Tak AS')}`, { kompletthet: 'komplett', kompletthetsvurdering: 'Komplett omfang, men levert dagen etter fristen.' });
  await api('PATCH', `/api/evaluering-tilbud/${et('Nordtak AS')}`, { kompletthet: 'mindre_mangler', kompletthetsvurdering: 'Fallsikring ikke nevnt.' });
  await api('PATCH', `/api/evaluering-tilbud/${et('Takservice Øst AS')}`, { kompletthet: 'vesentlige_mangler', kompletthetsvurdering: 'Mangler fallsikring, sluk og kran. Forbehold om detaljprosjektering.' });
  await api('PATCH', `/api/evaluering-tilbud/${et('Membranteknikk AS')}`, { kompletthet: 'mindre_mangler', kompletthetsvurdering: 'Heising bare delvis med.' });

  const dokTakservice = await en<{ id: string }>(db, 'select id from dokument where tilbud_id = $1', [tilbudId['Takservice Øst AS']]);
  await api('POST', `/api/prosjekt-fag/${tak}/forbehold`, {
    tilbudId: tilbudId['Takservice Øst AS'],
    tekst: 'Forbehold om endringer som følge av detaljprosjektering',
    kategori: 'detaljprosjektering',
    konsekvens: 'Uforenlig med totalentreprise. Må trekkes eller prises.',
    status: 3,
    vesentlig: true,
    kildeType: 'tilbud',
    kildeDokumentId: dokTakservice!.id,
    kildeRef: 's. 1, pkt. 6',
  });
  await api('POST', `/api/prosjekt-fag/${tak}/forbehold`, {
    tilbudId: tilbudId['Membranteknikk AS'],
    tekst: 'Vedståelse bare til 10.01.2027',
    kategori: 'kontrakt',
    konsekvens: 'Går ut før forventet kontraktsdato 15.01.2027. Be om forlengelse.',
    status: 2,
    vesentlig: true,
    kildeType: 'tilbud',
    kildeDokumentId: dokMembran!.id,
    kildeRef: 's. 1',
  });

  await api('PATCH', `/api/evalueringer/${ev.id}`, {
    anbefaling: 'Membranteknikk AS anbefales som laveste evaluerte, forutsatt avklart heising og forlenget vedståelse.',
    storsteRisikoer: 'Kort vedståelse hos Membranteknikk. Fallsikring er anslag.',
  });

  return { evalueringId: ev.id, prosjektId: prosjekt.id };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const db = lagPool(config.databaseUrl);
  try {
    await migrer(db);
    const lagring = new LokalLagring(config.dokumentmappe);
    const app = await byggApp({ db, lagring });
    const res = await seedEksempel(db, app, lagring);
    console.log(res ? `Seed-data lagt inn: prosjekt ${PROSJEKTNR} Eksempelveien skole.` : `Prosjekt ${PROSJEKTNR} finnes allerede. Ingenting gjort.`);
    await app.close();
  } finally {
    await db.end();
  }
}
