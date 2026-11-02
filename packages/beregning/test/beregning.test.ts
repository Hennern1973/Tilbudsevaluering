import { describe, expect, it } from 'vitest';
import {
  D,
  etterFrist,
  evaluerMalB,
  finnVarsler,
  formaterProsent,
  formaterTall,
  justeringsbelop,
  kanSettesFerdig,
  kapittelFraMappenavn,
  lagSammendrag,
  overordnetNummer,
  parseNorskTall,
  ranger,
  sammenlignFagnummer,
  sorteringsnokkel,
} from '../src/index.js';
import { BTA, taktekking } from './eksempel.js';

const s = (d: { toFixed: (n: number) => string } | null) => (d === null ? null : d.toFixed(2));

describe('tall', () => {
  it('tolker norske tall fra Excel', () => {
    expect(parseNorskTall('1 234 567,50')?.toFixed(2)).toBe('1234567.50');
    expect(parseNorskTall('1 234,5')?.toFixed(2)).toBe('1234.50');
    expect(parseNorskTall('1.234,50')?.toFixed(2)).toBe('1234.50');
    expect(parseNorskTall('1234.5')?.toFixed(2)).toBe('1234.50');
    expect(parseNorskTall('−12,3')?.toFixed(1)).toBe('-12.3');
    expect(parseNorskTall('kr 85 000,-')?.toFixed(0)).toBe('85000');
    expect(parseNorskTall('  ')).toBeNull();
  });

  it('kaster på ugyldig tekst i stedet for å gi 0', () => {
    expect(() => parseNorskTall('ca. 100')).toThrow(/Ugyldig tall/);
    expect(() => parseNorskTall('inkl.')).toThrow();
  });

  it('formaterer med mellomrom som tusenskille og komma som desimal', () => {
    expect(formaterTall('2405000')).toBe('2 405 000');
    expect(formaterTall('-35000.5', 2)).toBe('-35 000,50');
    expect(formaterTall('0.004', 2)).toBe('0,00');
    expect(formaterTall('-0.004', 2)).toBe('0,00');
    expect(formaterTall(null)).toBe('');
    expect(formaterProsent(new D('0.024948'))).toBe('2,5 %');
  });

  it('regner uten flyttallsfeil', () => {
    expect(justeringsbelop({ grunnbelop: '0.1', faktor: '3', fortegn: 1 }).toFixed(2)).toBe('0.30');
    expect(justeringsbelop({ grunnbelop: '33333.335', fortegn: -1 }).toFixed(2)).toBe('-33333.34');
  });
});

describe('fagkapittel', () => {
  it('sorterer 82.10 etter 82.9 og holder 05.1 og 5.1 adskilt', () => {
    const liste = ['82.10', '82.9', '05.1', '5.1', '05', '17.1', '03', '82.01'];
    expect([...liste].sort(sammenlignFagnummer)).toEqual(['03', '05', '05.1', '5.1', '17.1', '82.01', '82.9', '82.10']);
    expect(sorteringsnokkel('82.10')).toBe('0082.0010');
  });

  it('finner overordnet kapittel og kapittel i mappenavn', () => {
    expect(overordnetNummer('05.1')).toBe('05');
    expect(overordnetNummer('05')).toBeNull();
    expect(kapittelFraMappenavn('17.1 Nordtak AS')).toBe('17.1');
    expect(kapittelFraMappenavn('Diverse')).toBeNull();
  });
});

describe('rangering', () => {
  it('gir lik plass ved lik sum, som RANG i Excel', () => {
    const plass = ranger([
      { id: 'a', verdi: new D(100) },
      { id: 'b', verdi: new D(100) },
      { id: 'c', verdi: new D(90) },
      { id: 'd', verdi: null },
    ]);
    expect(Object.fromEntries(plass)).toEqual({ c: 1, a: 2, b: 2 });
  });
});

describe('mal B – 17.1 Taktekking', () => {
  const res = evaluerMalB(taktekking, { bta: BTA });
  const finn = (id: string) => res.find((r) => r.id === id)!;

  it('evaluert sum = tilbudssum + justeringer', () => {
    expect(s(finn('nordtak').evaluertSum)).toBe('2465000.00');
    expect(s(finn('takservice').evaluertSum)).toBe('2482000.00');
    expect(s(finn('fjellstad').evaluertSum)).toBe('2520000.00');
    expect(s(finn('membran').evaluertSum)).toBe('2405000.00');
  });

  it('laveste i brevet blir nummer tre etter justering', () => {
    expect(res.map((r) => [r.id, r.rangering])).toEqual([
      ['nordtak', 2],
      ['takservice', 3],
      ['fjellstad', 4],
      ['membran', 1],
    ]);
  });

  it('differanse, prosent, NOK/m² og andel kalkulatoriske tillegg', () => {
    const n = finn('nordtak');
    expect(s(n.diffMotLaveste)).toBe('60000.00');
    expect(n.diffProsent!.toFixed(6)).toBe('0.024948');
    expect(s(finn('membran').nokPerM2)).toBe('697.10');
    expect(s(finn('membran').sumTillegg)).toBe('30000.00');
    expect(finn('takservice').andelKalkTillegg!.toFixed(4)).toBe('0.0753');
    expect(finn('fjellstad').andelKalkTillegg!.toFixed(4)).toBe('0.0000');
  });

  it('kontroll mot prisfordeling bare når den er oppgitt', () => {
    expect(finn('nordtak').kontrolldifferanse?.toFixed(0)).toBe('0');
    expect(finn('takservice').kontrolldifferanse).toBeNull();
    expect(finn('takservice').kontrollOk).toBe(true);
  });

  it('kontrollen rundes til hele kroner', () => {
    const [nesten] = evaluerMalB([{ ...taktekking[0]!, prisfordeling: ['2379999.60'] }]);
    expect(nesten!.kontrollOk).toBe(true);
    const [avvik] = evaluerMalB([{ ...taktekking[0]!, prisfordeling: ['2379999.40'] }]);
    expect(avvik!.kontrolldifferanse!.toFixed(0)).toBe('-1');
    expect(avvik!.kontrollOk).toBe(false);
  });

  it('tilbud utenfor evalueringen eller uten sum rangeres ikke', () => {
    const r = evaluerMalB([
      ...taktekking,
      { id: 'x', navn: 'Uten sum', medIEvaluering: true, tilbudssum: null, justeringer: [] },
      { id: 'y', navn: 'Holdt utenfor', medIEvaluering: false, tilbudssum: '1000', justeringer: [] },
    ]);
    expect(r.find((x) => x.id === 'x')!.rangering).toBeNull();
    expect(r.find((x) => x.id === 'y')!.rangering).toBeNull();
    expect(r.find((x) => x.id === 'membran')!.rangering).toBe(1);
  });
});

describe('sammendrag', () => {
  const res = evaluerMalB(taktekking, { bta: BTA });

  it('bruker laveste når ingen er valgt', () => {
    const sm = lagSammendrag({ resultater: res, heAnslag: '2300000', bta: BTA });
    expect(sm.laveste?.navn).toBe('Membranteknikk AS');
    expect(sm.antallEvaluert).toBe(4);
    expect(sm.valgt?.valgtManuelt).toBe(false);
    expect(s(sm.tilKalkyle)).toBe('2405000.00');
    expect(s(sm.avvikHeAnslag)).toBe('105000.00');
    expect(sm.avvikHeAnslagProsent!.toFixed(4)).toBe('0.0457');
  });

  it('til kalkyle = evaluert sum valgt UE + risikotillegg', () => {
    const sm = lagSammendrag({ resultater: res, valgtTilbudId: 'nordtak', risikotillegg: '50000' });
    expect(sm.valgt?.navn).toBe('Nordtak AS');
    expect(sm.valgt?.erLaveste).toBe(false);
    expect(s(sm.valgt!.tilbudssum)).toBe('2380000.00');
    expect(s(sm.tilKalkyle)).toBe('2515000.00');
  });

  it('ignorerer et valgt tilbud som ikke er rangert', () => {
    const sm = lagSammendrag({ resultater: res, valgtTilbudId: 'finnes-ikke' });
    expect(sm.valgt?.id).toBe('membran');
  });
});

describe('ferdig evaluert', () => {
  it('blokkeres av kontrollavvik og manglende tilbudssum', () => {
    const ok = kanSettesFerdig(evaluerMalB(taktekking));
    expect(ok.ok).toBe(true);

    const feil = kanSettesFerdig(
      evaluerMalB([
        { ...taktekking[0]!, prisfordeling: ['2000000'] },
        { ...taktekking[1]!, tilbudssum: null },
      ]),
    );
    expect(feil.ok).toBe(false);
    expect(feil.avvik.map((a) => a.grunn)).toEqual([
      'Kontrolldifferanse -380000 kr mot tilbudssummen',
      'Tilbudssum fra tilbudsbrevet mangler',
    ]);
  });
});

describe('frist og varsler', () => {
  it('etter frist', () => {
    const frist = new Date('2026-11-10T12:00:00+01:00');
    expect(etterFrist(new Date('2026-11-10T11:59:00+01:00'), frist)).toBe(false);
    expect(etterFrist(new Date('2026-11-10T12:01:00+01:00'), frist)).toBe(true);
    expect(etterFrist(new Date('2030-01-01'), null)).toBe(false);
  });

  it('flagger laveste med åpne punkter, sen levering og forbehold', () => {
    const res = evaluerMalB(taktekking);
    const v = finnVarsler(
      res,
      [
        { id: 'membran', etterFrist: false, vedstaelsesfrist: new Date('2026-12-01'), apneOmfangspunkter: 1, kompletthet: 'mindre_mangler', forbeholdKategorier: [] },
        { id: 'fjellstad', etterFrist: true, vedstaelsesfrist: null, apneOmfangspunkter: 0, kompletthet: 'komplett', forbeholdKategorier: [] },
        { id: 'takservice', etterFrist: false, vedstaelsesfrist: null, apneOmfangspunkter: 3, kompletthet: null, forbeholdKategorier: ['detaljprosjektering'] },
      ],
      { forventetKontraktsdato: new Date('2027-01-15') },
    );
    expect(v.map((x) => `${x.tilbudId}:${x.type}`)).toEqual([
      'membran:kort_vedstaelse',
      'membran:laveste_med_apne_punkter',
      'fjellstad:etter_frist',
      'takservice:forbehold_detaljprosjektering',
    ]);
  });
});
