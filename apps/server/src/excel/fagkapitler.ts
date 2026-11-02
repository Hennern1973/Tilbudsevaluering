import ExcelJS from 'exceljs';

export interface ImportertFag {
  nummer: string;
  navn: string;
  rad: number;
}

export interface FagImport {
  fag: ImportertFag[];
  advarsler: string[];
}

/**
 * Leser arket «Fagkapitler» (.xlsx/.xlsm) med kolonnene nummer og navn.
 * Overskriftsraden finnes automatisk blant de ti første radene. Nummeret leses som vist tekst,
 * slik at «05» ikke blir 5. Er cellen lagret som tall i Excel, kommer en advarsel,
 * fordi «82.10» da allerede er blitt 82.1 i filen.
 */
export async function lesFagkapitler(innhold: Buffer): Promise<FagImport> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(innhold as unknown as ArrayBuffer);
  const ark = wb.worksheets.find((w) => w.name.trim().toLowerCase() === 'fagkapitler');
  if (!ark) {
    throw new Error(`Fant ikke arket «Fagkapitler». Arkene i filen er: ${wb.worksheets.map((w) => `«${w.name}»`).join(', ')}`);
  }

  let nummerKol = 1;
  let navnKol = 2;
  let forsteRad = 1;
  for (let r = 1; r <= Math.min(10, ark.rowCount); r++) {
    const rad = ark.getRow(r);
    let nk = 0;
    let ak = 0;
    rad.eachCell((celle, kol) => {
      const t = celle.text.trim().toLowerCase();
      if (['nummer', 'nr', 'nr.', 'kap', 'kap.', 'kap.nr', 'kapittel'].includes(t)) nk = kol;
      if (['navn', 'fag', 'fagkapittel', 'beskrivelse'].includes(t)) ak = kol;
    });
    if (nk && ak) {
      nummerKol = nk;
      navnKol = ak;
      forsteRad = r + 1;
      break;
    }
  }

  const fag: ImportertFag[] = [];
  const advarsler: string[] = [];
  const sett = new Set<string>();
  for (let r = forsteRad; r <= ark.rowCount; r++) {
    const rad = ark.getRow(r);
    const nCelle = rad.getCell(nummerKol);
    const nummer = nCelle.text.trim();
    const navn = rad.getCell(navnKol).text.trim();
    if (!nummer && !navn) continue;
    if (!nummer || !navn) {
      advarsler.push(`Rad ${r}: mangler ${nummer ? 'navn' : 'nummer'} og er hoppet over.`);
      continue;
    }
    if (!/^\d+(\.\d+)*$/.test(nummer)) {
      advarsler.push(`Rad ${r}: «${nummer}» er ikke et gyldig kapittelnummer og er hoppet over.`);
      continue;
    }
    if (nCelle.type === ExcelJS.ValueType.Number) {
      advarsler.push(`Rad ${r}: nummeret ${nummer} er lagret som tall i Excel. Sjekk at det ikke skulle vært f.eks. «${nummer}0».`);
    }
    if (sett.has(nummer)) {
      advarsler.push(`Rad ${r}: ${nummer} finnes flere ganger i filen. Siste forekomst brukes.`);
      const i = fag.findIndex((f) => f.nummer === nummer);
      fag.splice(i, 1);
    }
    sett.add(nummer);
    fag.push({ nummer, navn: navn.replace(/\s+/g, ' '), rad: r });
  }
  return { fag, advarsler };
}
