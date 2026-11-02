import { D } from '@tilbud/beregning';
import ExcelJS from 'exceljs';
import type { EvalueringData } from '../evalueringsdata.js';

const MALNAVN: Record<string, string> = {
  A: 'A – Mengder og enhetspriser',
  B: 'B – Totalunderentreprise',
  C: 'C – Grunn og utomhus',
};

const STATUS_FORESPORSEL: Record<string, string> = {
  forespurt: 'Forespurt',
  tilbud_mottatt: 'Tilbud mottatt',
  regner_ikke: 'Regner ikke',
  ikke_svart: 'Ikke svart',
};

const KOMPLETTHET: Record<string, string> = {
  komplett: 'Komplett',
  mindre_mangler: 'Mindre mangler',
  vesentlige_mangler: 'Vesentlige mangler',
};

const KR = '#,##0;-#,##0';
const PROSENT = '0.0%';
const BLAA = 'FF1F4E9E';
const GUL = 'FFFFF2CC';

/** Tekst med punktum som desimal → tall i Excel. Bare her, ved eksportgrensen, blir beløp til number. */
const tall = (v: string | null | undefined) => (v === null || v === undefined ? null : Number(v));
const OSLO_DATO = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Oslo' });
/** Dato (tekst «ÅÅÅÅ-MM-DD» eller tidspunkt) → Excel-dato for dagen i norsk tid. */
const dato = (v: string | Date | null | undefined) => {
  if (!v) return null;
  const dag = v instanceof Date ? OSLO_DATO.format(v) : v.length > 10 ? OSLO_DATO.format(new Date(v)) : v;
  return new Date(`${dag}T12:00:00Z`);
};

/**
 * Eksporterer fagets sammendrag i samme layout som arket «Sammendrag» i malene (A1:L65).
 * Rad 65 er lenkeraden som prosjektets tilbudssammendrag/kalkyle lenker til, så celleadressene er faste.
 */
export async function lagSammendragXlsx(d: EvalueringData): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Tilbudsevaluering';
  wb.created = new Date();
  const ws = wb.addWorksheet('Sammendrag', { views: [{ showGridLines: false }] });
  ws.columns = [28, 12, 16, 15, 16, 10, 14, 9, 13, 12, 44, 18].map((width) => ({ width }));

  const e = d.evaluering;
  const sm = d.sammendrag;
  const fet = { bold: true };

  ws.getCell('A1').value = 'SAMMENDRAG – TILBUDSEVALUERING';
  ws.getCell('A1').font = { bold: true, size: 14 };
  const hode: [string, string][] = [
    ['Kap.nr', e.fag_nummer],
    ['Fag', e.fag_navn],
    ['Prosjekt', `${e.prosjekt_nummer} ${e.prosjekt_navn}`],
    ['Evalueringsmal', MALNAVN[e.mal] ?? e.mal],
    ['Utarbeidet / rev.', `Rev. ${e.revisjon} · ${new Date().toISOString().slice(0, 10)} · ${statusTekst(e.status)}`],
  ];
  hode.forEach(([etikett, verdi], i) => {
    ws.getCell(2 + i, 1).value = etikett;
    ws.getCell(2 + i, 1).font = fet;
    ws.getCell(2 + i, 2).value = verdi;
  });
  ws.getCell('B2').value = e.fag_nummer;
  ws.getCell('B2').numFmt = '@';
  ws.getCell('F2').value = 'Dette arket har faste celleadresser. Kalkylen lenker til rad 65. Ikke flytt celler.';
  ws.getCell('F2').font = { italic: true, size: 9, color: { argb: 'FF666666' } };

  const kolonner = [
    'Tilbyder', 'Tilbudsdato', 'Oppgitt tilbudssum (tilbudsbrev)', 'Tillegg / fradrag (evaluering)', 'Evaluert sum',
    'Rangering', 'Diff. mot laveste', 'Diff. %', 'Andel kalk. tillegg / ikke priset', 'Gyldig til',
    'Vesentlige forbehold (kort)', 'Kompletthet',
  ];
  overskriftsrad(ws, 9, kolonner);

  // Rad 10–19: tilbyderne, rangert først. Maks 10 rader som i malen.
  const sortert = [...d.tilbud]
    .filter((t) => t.med_i_evaluering)
    .sort((a, b) => (a.resultat.rangering ?? 999) - (b.resultat.rangering ?? 999) || a.tilbyder.localeCompare(b.tilbyder, 'nb'));
  const vist = sortert.slice(0, 10);
  vist.forEach((t, i) => {
    const r = ws.getRow(10 + i);
    const forbehold = d.forbehold.filter((f) => f.tilbud_id === t.tilbud_id && f.vesentlig).map((f) => f.tekst);
    r.values = [
      t.tilbyder + (t.etter_frist ? ' (etter frist)' : ''),
      dato(t.tilbudsdato ?? t.mottatt_tid),
      tall(t.resultat.tilbudssum),
      tall(t.resultat.sumJusteringer),
      tall(t.resultat.evaluertSum),
      t.resultat.rangering,
      tall(t.resultat.diffMotLaveste),
      tall(t.resultat.diffProsent),
      tall(t.resultat.andelKalkTillegg),
      dato(t.vedstaelsesfrist),
      forbehold.join(' · ') || null,
      t.kompletthet ? KOMPLETTHET[t.kompletthet] : null,
    ];
    formaterTilbydderad(r);
    r.getCell(3).font = { color: { argb: BLAA } };
  });
  if (sortert.length > vist.length) {
    ws.getCell('A20').value = `${sortert.length - vist.length} tilbud til er evaluert, men ikke vist (maks 10 i dette arket).`;
    ws.getCell('A20').font = { italic: true, size: 9 };
  }

  const linje = (rad: number, etikett: string, verdi: ExcelJS.CellValue, kol = 5, numFmt = KR) => {
    ws.getCell(rad, 1).value = etikett;
    ws.getCell(rad, 1).font = fet;
    const c = ws.getCell(rad, kol);
    c.value = verdi;
    if (typeof verdi === 'number') c.numFmt = numFmt;
  };
  linje(21, 'Laveste evaluerte tilbud', tall(sm.laveste?.evaluertSum));
  ws.getCell('B21').value = sm.laveste?.navn ?? null;
  linje(22, 'Antall evaluerte tilbud', sm.antallEvaluert, 5, '0');
  ws.getCell('A23').value = 'Valgt UE (lagt til grunn i kalkylen)';
  ws.getCell('A23').font = fet;
  ws.getCell('B23').value = sm.valgt?.valgtManuelt ? sm.valgt.navn : null;
  linje(24, 'Evaluert sum valgt UE', tall(sm.valgt?.evaluertSum));
  ws.getCell('F24').value = sm.valgt && !sm.valgt.valgtManuelt ? '← laveste brukes når ingen er valgt' : null;
  linje(25, 'Risikotillegg / usikkerhet', tall(sm.risikotillegg));
  ws.getCell('F25').value = e.risikotillegg_begrunnelse;
  ws.getCell('E25').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GUL } };
  linje(26, 'TIL KALKYLE', tall(sm.tilKalkyle));
  ws.getCell('E26').font = { bold: true };
  ws.getCell('E26').border = { top: { style: 'thin' }, bottom: { style: 'double' } };
  linje(27, 'HE-anslag / budsjett før tilbud', tall(sm.heAnslag));
  linje(28, 'Avvik mot HE-anslag', tall(sm.avvikHeAnslag));
  const pc = ws.getCell('F28');
  pc.value = tall(sm.avvikHeAnslagProsent);
  pc.numFmt = PROSENT;

  ws.getCell('A30').value = 'Vesentlige forbehold og avklaringer (de viktigste – vises i samlearket)';
  ws.getCell('A30').font = fet;
  const vesentlige = d.forbehold.filter((f) => f.vesentlig).slice(0, 5);
  vesentlige.forEach((f, i) => {
    const t = d.tilbud.find((x) => x.tilbud_id === f.tilbud_id);
    ws.getCell(31 + i, 1).value = t ? `${t.tilbyder}: ${f.tekst}` : f.tekst;
  });

  ws.getCell('A37').value = 'Anbefaling';
  ws.getCell('A37').font = fet;
  ws.mergeCells('A38:L39');
  ws.getCell('A38').value = e.anbefaling ?? null;
  ws.getCell('A38').alignment = { wrapText: true, vertical: 'top' };

  ws.getCell('A40').value = 'Forespurte tilbydere og status';
  ws.getCell('A40').font = fet;
  overskriftsrad(ws, 41, ['Tilbyder', 'Status', 'Dato', 'Kommentar']);
  d.foresporsler.slice(0, 20).forEach((f, i) => {
    const t = d.tilbud.find((x) => x.tilbyder === f.tilbyder);
    const kommentar = [t?.etter_frist ? 'Levert etter frist' : null, f.kommentar].filter(Boolean).join('. ');
    ws.getRow(42 + i).values = [f.tilbyder, STATUS_FORESPORSEL[f.status] ?? f.status, dato(f.dato_forespurt), kommentar || null];
    ws.getCell(42 + i, 3).numFmt = 'dd.mm.yyyy';
  });

  ws.getCell('A63').value = 'LENKERAD TIL TILBUDSSAMMENDRAG – rad 65 lenkes inn i fagets rad (Lim inn kobling i kol. E)';
  ws.getCell('A63').font = { bold: true, color: { argb: 'FF2E7D32' } };
  overskriftsrad(ws, 64, [
    'Ant. forespurt', 'Ant. evaluert', 'Laveste tilbyder', 'Laveste evaluert sum', 'Valgt UE',
    'Tilbudssum valgt (tilbudsbrev)', 'Tillegg / fradrag', 'Evaluert sum valgt UE', 'Risikotillegg', 'TIL KALKYLE',
    'HE-anslag', 'Vesentlige forbehold',
  ]);
  const tilbudssumValgt = tall(sm.valgt?.tilbudssum);
  const evaluertValgt = tall(sm.valgt?.evaluertSum);
  const risiko = tall(sm.risikotillegg);
  const rad65 = ws.getRow(65);
  rad65.values = [
    d.foresporsler.length || null,
    sm.antallEvaluert || null,
    sm.laveste?.navn ?? null,
    tall(sm.laveste?.evaluertSum),
    sm.valgt?.navn ?? null,
    tilbudssumValgt,
    tilbudssumValgt !== null && evaluertValgt !== null ? new D(sm.valgt!.evaluertSum!).minus(sm.valgt!.tilbudssum!).toNumber() : null,
    evaluertValgt,
    risiko === 0 ? null : risiko,
    tall(sm.tilKalkyle),
    tall(sm.heAnslag),
    vesentlige.map((f) => f.tekst).join(' · ') || null,
  ];
  for (const k of [4, 6, 7, 8, 9, 10, 11]) rad65.getCell(k).numFmt = KR;
  rad65.eachCell((c) => {
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8F5E9' } };
  });

  ws.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, printArea: 'A1:L65' };

  leggTilDetaljark(wb, d);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function statusTekst(s: string): string {
  return { under_evaluering: 'Under evaluering', ferdig_evaluert: 'Ferdig evaluert', ks_godkjent: 'KS godkjent' }[s] ?? s;
}

function overskriftsrad(ws: ExcelJS.Worksheet, rad: number, tekster: string[]) {
  const r = ws.getRow(rad);
  r.values = tekster;
  r.font = { bold: true };
  r.alignment = { wrapText: true, vertical: 'bottom' };
  r.eachCell((c) => {
    c.border = { bottom: { style: 'thin' } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F2F2' } };
  });
}

function formaterTilbydderad(r: ExcelJS.Row) {
  r.getCell(2).numFmt = 'dd.mm.yyyy';
  for (const k of [3, 4, 5, 7]) r.getCell(k).numFmt = KR;
  r.getCell(8).numFmt = PROSENT;
  r.getCell(9).numFmt = PROSENT;
  r.getCell(10).numFmt = 'dd.mm.yyyy';
  r.getCell(11).alignment = { wrapText: true, vertical: 'top' };
}

/** Sporbarhet: forutsetninger og justeringer med kilde, på egne ark etter Sammendrag. */
function leggTilDetaljark(wb: ExcelJS.Workbook, d: EvalueringData) {
  const fu = wb.addWorksheet('Forutsetninger');
  fu.columns = [6, 50, 14, 60].map((width) => ({ width }));
  overskriftsrad(fu, 1, ['Nr', 'Forutsetning', 'Beløp', 'Grunnlag / kilde']);
  d.forutsetninger.forEach((f, i) => {
    const r = fu.getRow(2 + i);
    r.values = [f.nr, f.tekst, tall(f.belop), f.grunnlag];
    r.getCell(3).numFmt = KR;
    r.getCell(3).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GUL } };
  });

  const ju = wb.addWorksheet('Justeringer');
  ju.columns = [26, 14, 50, 8, 14, 50].map((width) => ({ width }));
  overskriftsrad(ju, 1, ['Tilbyder', 'Type', 'Grunnlag (forutsetning / egen post)', 'Faktor', 'Beløp', 'Begrunnelse']);
  let rad = 2;
  for (const t of d.tilbud) {
    for (const j of t.justeringer) {
      const r = ju.getRow(rad++);
      r.values = [
        t.tilbyder,
        j.type + (j.overlapp_fag ? ` mot ${j.overlapp_fag}` : ''),
        j.grunntekst,
        Number(j.faktor),
        tall(j.belop),
        j.begrunnelse,
      ];
      r.getCell(5).numFmt = KR;
    }
  }
}
