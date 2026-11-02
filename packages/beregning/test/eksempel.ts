import type { TilbudMalBInput } from '../src/index.js';

/**
 * «17.1 Taktekking», fire tilbydere. Samme tall brukes i seed-dataene i apps/server/db/seed.ts.
 *
 * Forutsetninger (felles anslag):
 *   F1 Fallsikring og sikkerhetsnett        85 000
 *   F2 Tilkobling taksluk og nedløp         42 000
 *   F3 Kran og heising av materialer        60 000
 */
export const F1 = '85000';
export const F2 = '42000';
export const F3 = '60000';
export const BTA = '3450';

export const taktekking: TilbudMalBInput[] = [
  {
    id: 'nordtak',
    navn: 'Nordtak AS',
    medIEvaluering: true,
    tilbudssum: '2380000',
    justeringer: [{ grunnbelop: F1, fortegn: 1 }],
    prisfordeling: ['1650000', '480000', '250000'],
  },
  {
    // Lavest i brevet, men mangler mest og har forbehold om detaljprosjektering.
    id: 'takservice',
    navn: 'Takservice Øst AS',
    medIEvaluering: true,
    tilbudssum: '2295000',
    justeringer: [
      { grunnbelop: F1, fortegn: 1 },
      { grunnbelop: F2, fortegn: 1 },
      { grunnbelop: F3, fortegn: 1 },
    ],
  },
  {
    // Levert etter frist, komplett.
    id: 'fjellstad',
    navn: 'Fjellstad Tak AS',
    medIEvaluering: true,
    tilbudssum: '2520000',
    justeringer: [],
  },
  {
    // Kran er delvis med (50 %), og beslag overlapper med 18 Blikkenslager (fradrag fra egen post).
    id: 'membran',
    navn: 'Membranteknikk AS',
    medIEvaluering: true,
    tilbudssum: '2410000',
    justeringer: [
      { grunnbelop: F3, faktor: '0.5', fortegn: 1 },
      { grunnbelop: '35000', fortegn: -1 },
    ],
  },
];
