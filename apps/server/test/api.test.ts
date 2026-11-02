import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedEksempel, KALKULATOR } from '../db/seed.js';
import { byggApp } from '../src/app.js';
import { type Db, lagPool } from '../src/db.js';
import { LokalLagring } from '../src/lagring.js';
import { migrer } from '../src/migrer.js';

/**
 * Integrasjonstester mot en ekte PostgreSQL. Databasen i TEST_DATABASE_URL tømmes før kjøring.
 * Uten TEST_DATABASE_URL hoppes testene over.
 */
const url = process.env.TEST_DATABASE_URL;
const beskriv = url ? describe : describe.skip;

beskriv('API mot database', () => {
  let db: Db;
  let app: FastifyInstance;
  let mappe: string;
  let evalueringId: string;

  const api = async (metode: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', u: string, body?: unknown) =>
    app.inject({ method: metode, url: u, payload: body as never, headers: { 'x-bruker-epost': KALKULATOR } });

  beforeAll(async () => {
    db = lagPool(url!);
    await db.query('drop schema public cascade; create schema public;');
    await migrer(db, undefined, () => {});
    mappe = await mkdtemp(path.join(os.tmpdir(), 'tilbud-'));
    const lagring = new LokalLagring(mappe);
    app = await byggApp({ db, lagring });
    const res = await seedEksempel(db, app, lagring);
    evalueringId = res!.evalueringId;
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
    if (mappe) await rm(mappe, { recursive: true, force: true });
  });

  it('regner samme tall som beregningsmodulens eksempel', async () => {
    const d = (await api('GET', `/api/evalueringer/${evalueringId}`)).json();
    const sum = Object.fromEntries(d.tilbud.map((t: any) => [t.tilbyder, [t.resultat.evaluertSum, t.resultat.rangering]]));
    expect(sum).toEqual({
      'Fjellstad Tak AS': ['2520000.00', 4],
      'Membranteknikk AS': ['2405000.00', 1],
      'Nordtak AS': ['2465000.00', 2],
      'Takservice Øst AS': ['2482000.00', 3],
    });
    expect(d.sammendrag.tilKalkyle).toBe('2405000.00');
    expect(d.sammendrag.avvikHeAnslag).toBe('105000.00');
    expect(d.tilbud.find((t: any) => t.tilbyder === 'Nordtak AS').resultat.kontrolldifferanse).toBe('0.00');
  });

  it('markerer tilbud etter frist og gir risikoflagg', async () => {
    const d = (await api('GET', `/api/evalueringer/${evalueringId}`)).json();
    const fjellstad = d.tilbud.find((t: any) => t.tilbyder === 'Fjellstad Tak AS');
    expect(fjellstad.etter_frist).toBe(true);
    expect(d.tilbud.filter((t: any) => t.etter_frist)).toHaveLength(1);
    const typer = d.varsler.map((v: any) => `${d.tilbud.find((t: any) => t.tilbud_id === v.tilbudId).tilbyder}:${v.type}`);
    expect(typer).toContain('Fjellstad Tak AS:etter_frist');
    expect(typer).toContain('Takservice Øst AS:forbehold_detaljprosjektering');
    expect(typer).toContain('Membranteknikk AS:kort_vedstaelse');
    expect(typer).toContain('Membranteknikk AS:laveste_med_apne_punkter');
  });

  it('avviser «fra tilbud» uten dokument og forutsetning uten begrunnelse', async () => {
    const d = (await api('GET', `/api/evalueringer/${evalueringId}`)).json();
    const t = d.tilbud[0];
    const r1 = await api('PATCH', `/api/tilbud/${t.tilbud_id}`, { tilbudssum: '1.00', kildeType: 'tilbud' });
    expect(r1.statusCode).toBe(400);
    expect(r1.json().feil).toMatch(/dokument/);
    const r2 = await api('POST', `/api/evalueringer/${evalueringId}/forutsetninger`, { tekst: 'X', belop: '100.00', grunnlag: '' });
    expect(r2.statusCode).toBe(400);
    // Databasen stopper det samme selv om API-et omgås.
    await expect(db.query(`update tilbud set kilde_dokument_id = null where id = $1`, [t.tilbud_id])).rejects.toThrow(/check/);
  });

  it('avviser justering med fritt beløp', async () => {
    const d = (await api('GET', `/api/evalueringer/${evalueringId}`)).json();
    const r = await api('POST', `/api/evaluering-tilbud/${d.tilbud[0].evaluering_tilbud_id}/justeringer`, { type: 'mangler', belop: '5000' });
    expect(r.statusCode).toBe(400);
  });

  it('logger hver endring per felt med bruker', async () => {
    const d = (await api('GET', `/api/evalueringer/${evalueringId}`)).json();
    const f = d.forutsetninger[0];
    await api('PATCH', `/api/forutsetninger/${f.id}`, { belop: '90000.00' });
    const logg = (await api('GET', `/api/endringslogg?tabell=forutsetning&radId=${f.id}`)).json();
    const endring = logg.find((l: any) => l.felt === 'belop');
    expect(endring).toMatchObject({ handling: 'endret', gammel: 85000, ny: 90000, bruker: 'Kari Kalkulatør' });
    // Felles anslag: alle tre som mangler fallsikring får nytt beløp.
    const etter = (await api('GET', `/api/evalueringer/${evalueringId}`)).json();
    expect(etter.tilbud.find((t: any) => t.tilbyder === 'Nordtak AS').resultat.evaluertSum).toBe('2470000.00');
    await api('PATCH', `/api/forutsetninger/${f.id}`, { belop: '85000.00' });
    await expect(db.query('delete from endringslogg')).rejects.toThrow(/kan ikke endres/);
  });

  it('blokkerer «ferdig evaluert» når kontrollen ikke går opp', async () => {
    const d = (await api('GET', `/api/evalueringer/${evalueringId}`)).json();
    const nordtak = d.tilbud.find((t: any) => t.tilbyder === 'Nordtak AS');
    const dok = nordtak.dokumenter[0].id;
    await api('PUT', `/api/tilbud/${nordtak.tilbud_id}/prisfordeling`, [
      { beskrivelse: 'Alt', belop: '2300000.00', kildeType: 'tilbud', kildeDokumentId: dok, kildeRef: 's. 2' },
    ]);
    const r = await api('POST', `/api/evalueringer/${evalueringId}/status`, { status: 'ferdig_evaluert' });
    expect(r.statusCode).toBe(409);
    expect(r.json().feil).toMatch(/Nordtak AS: Kontrolldifferanse -80000/);

    await api('PUT', `/api/tilbud/${nordtak.tilbud_id}/prisfordeling`, [
      { beskrivelse: 'Alt', belop: '2380000.00', kildeType: 'tilbud', kildeDokumentId: dok, kildeRef: 's. 2' },
    ]);
    const ok = await api('POST', `/api/evalueringer/${evalueringId}/status`, { status: 'ferdig_evaluert' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().evaluering.status).toBe('ferdig_evaluert');
    await api('POST', `/api/evalueringer/${evalueringId}/status`, { status: 'under_evaluering' });
  });

  it('revidert tilbud erstatter forrige versjon og arver «etter frist»', async () => {
    const fag = (await api('GET', `/api/evalueringer/${evalueringId}`)).json();
    const pf = (await api('GET', `/api/prosjekt-fag/${fag.evaluering.prosjekt_fag_id}`)).json();
    const fo = pf.foresporsler.find((f: any) => f.firmanavn === 'Fjellstad Tak AS');
    const r = await api('POST', `/api/foresporsler/${fo.id}/tilbud`, { mottattTid: '2026-11-20T10:00:00+01:00', tilbudsnr: 'FT 26/118 rev. A' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ versjon: 2, etter_frist: true });
    const etter = (await api('GET', `/api/evalueringer/${evalueringId}`)).json();
    const f = etter.tilbud.find((t: any) => t.tilbyder === 'Fjellstad Tak AS');
    expect(f.versjon).toBe(2);
    expect(f.resultat.evaluertSum).toBeNull(); // Ny versjon har ingen sum før den er registrert.
    expect(etter.tilbud).toHaveLength(4);
  });

  it('eksporterer sammendraget med lenkerad 65', async () => {
    const r = await api('GET', `/api/evalueringer/${evalueringId}/eksport.xlsx`);
    expect(r.statusCode).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(r.rawPayload as unknown as ArrayBuffer);
    const ws = wb.getWorksheet('Sammendrag')!;
    expect(ws.getCell('A1').value).toBe('SAMMENDRAG – TILBUDSEVALUERING');
    expect(ws.getCell('B2').value).toBe('17.1');
    expect(ws.getCell('A10').value).toBe('Membranteknikk AS');
    expect(ws.getCell('E10').value).toBe(2405000);
    expect(ws.getCell('F10').value).toBe(1);
    expect(ws.getCell('E26').value).toBe(2405000);
    expect(ws.getCell('E65').value).toBe('Membranteknikk AS');
    expect(ws.getCell('F65').value).toBe(2410000);
    expect(ws.getCell('G65').value).toBe(-5000);
    expect(ws.getCell('J65').value).toBe(2405000);
    expect(ws.getCell('A65').value).toBe(5);
    expect(String(ws.getCell('L65').value)).toMatch(/detaljprosjektering/);
    expect(wb.getWorksheet('Forutsetninger')!.getCell('B2').value).toBe('Fallsikring og sikkerhetsnett');
  });

  it('importerer fagkapitler fra Excel og varsler om tall-celler', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Fagkapitler');
    ws.addRow(['Nummer', 'Navn']);
    ws.addRow(['70.4', 'Utomhusarbeider']);
    ws.addRow(['17.1', 'Tekkearbeider (nytt navn)']);
    ws.addRow([82.1, 'Feil: lagret som tall']);
    ws.addRow(['abc', 'Ugyldig']);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const grense = '----tilbudgrense';
    const body = Buffer.concat([
      Buffer.from(`--${grense}\r\nContent-Disposition: form-data; name="fil"; filename="fag.xlsx"\r\nContent-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n`),
      buf,
      Buffer.from(`\r\n--${grense}--\r\n`),
    ]);
    const r = await app.inject({
      method: 'POST',
      url: '/api/fagkapitler/import',
      payload: body,
      headers: { 'content-type': `multipart/form-data; boundary=${grense}`, 'x-bruker-epost': KALKULATOR },
    });
    expect(r.statusCode).toBe(200);
    const res = r.json();
    expect(res).toMatchObject({ lest: 3, nye: 2, endret: 1 });
    expect(res.advarsler.join(' ')).toMatch(/82\.1 er lagret som tall/);
    expect(res.advarsler.join(' ')).toMatch(/«abc» er ikke et gyldig/);

    const fag = (await api('GET', '/api/fagkapitler')).json().map((f: any) => f.nummer);
    expect(fag.indexOf('82.9')).toBeLessThan(fag.indexOf('82.10'));
  });

  it('prosjektoversikten summerer UE-kost og NOK/m²', async () => {
    const d = (await api('GET', `/api/evalueringer/${evalueringId}`)).json();
    const o = (await api('GET', `/api/prosjekter/${d.evaluering.prosjekt_id}/oversikt`)).json();
    const tak = o.fag.find((f: any) => f.nummer === '17.1');
    expect(tak).toMatchObject({ antall_forespurt: 5, antall_mottatt: 4, tilKalkyle: expect.any(String), valgtUe: expect.any(String) });
    expect(o.total.antallFagIKalkyle).toBe(1);
    expect(o.fag.map((f: any) => f.nummer)).toEqual(['01', '03', '05.1', '08.2', '17.1', '18', '31', '36', '41', '56']);
  });

  it('krever innlogget bruker', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/prosjekter', headers: { 'x-bruker-epost': 'ukjent@eksempel.no' } });
    expect(r.statusCode).toBe(401);
  });
});
