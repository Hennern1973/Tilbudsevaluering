import { type FormEvent, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { datoTekst, Feil, kr, Seksjon, useLast } from '../felles';

interface Prosjekt {
  id: string;
  nummer: string;
  navn: string;
  byggherre: string | null;
  status: string;
  bta_m2: string | null;
  tilbudsfrist_bh: string | null;
  antall_fag: number;
}

export function ProsjektListe() {
  const { data, feil } = useLast<Prosjekt[]>(() => api.get('/prosjekter'), []);
  const [skjemaFeil, setSkjemaFeil] = useState<string | null>(null);
  const navigate = useNavigate();

  const opprett = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const verdi = (n: string) => String(f.get(n) ?? '').trim() || null;
    try {
      const bta = verdi('bta');
      const p = await api.send<{ id: string }>('POST', '/prosjekter', {
        nummer: verdi('nummer'),
        navn: verdi('navn'),
        byggherre: verdi('byggherre'),
        kontraktsform: verdi('kontraktsform'),
        btaM2: bta ? bta.replace(/\s/g, '').replace(',', '.') : null,
        forventetKontraktsdato: verdi('kontraktsdato'),
      });
      navigate(`/prosjekter/${p.id}`);
    } catch (err) {
      setSkjemaFeil((err as Error).message);
    }
  };

  return (
    <>
      <h1>Prosjekter</h1>
      <Feil melding={feil} />
      <Seksjon tittel="Prosjekter i kalkulasjon">
        <table className="enkel">
          <thead>
            <tr>
              <th>Nr.</th>
              <th>Navn</th>
              <th>Byggherre</th>
              <th>Status</th>
              <th className="tall">BTA m²</th>
              <th>Tilbudsfrist BH</th>
              <th className="tall">Fag</th>
            </tr>
          </thead>
          <tbody>
            {data?.map((p) => (
              <tr key={p.id}>
                <td>
                  <Link to={`/prosjekter/${p.id}`}>{p.nummer}</Link>
                </td>
                <td>
                  <Link to={`/prosjekter/${p.id}`}>{p.navn}</Link>
                </td>
                <td>{p.byggherre}</td>
                <td>{p.status}</td>
                <td className="tall">{kr(p.bta_m2)}</td>
                <td>{datoTekst(p.tilbudsfrist_bh)}</td>
                <td className="tall">{p.antall_fag}</td>
              </tr>
            ))}
            {data?.length === 0 && (
              <tr>
                <td colSpan={7} className="dempet">
                  Ingen prosjekter ennå. Opprett ett under, eller kjør <code>npm run db:seed</code> for eksempeldata.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Seksjon>

      <Seksjon tittel="Nytt prosjekt">
        <Feil melding={skjemaFeil} lukk={() => setSkjemaFeil(null)} />
        <form className="skjema" onSubmit={opprett}>
          <label>
            Prosjektnr.
            <input name="nummer" required placeholder="26-123" />
          </label>
          <label>
            Navn
            <input name="navn" required />
          </label>
          <label>
            Byggherre
            <input name="byggherre" />
          </label>
          <label>
            Kontraktsform
            <select name="kontraktsform" defaultValue="NS 8407">
              <option>NS 8407</option>
              <option>NS 8405</option>
              <option value="annet">Annet</option>
            </select>
          </label>
          <label>
            BTA m²
            <input name="bta" inputMode="decimal" />
          </label>
          <label>
            Forventet kontraktsdato
            <input name="kontraktsdato" type="date" />
          </label>
          <button className="primar">Opprett</button>
        </form>
      </Seksjon>
    </>
  );
}
