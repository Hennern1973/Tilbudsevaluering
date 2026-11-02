import { useEffect, useState } from 'react';
import { Link, Route, Routes } from 'react-router-dom';
import { api } from './api';
import { EvalueringSide } from './sider/EvalueringSide';
import { FagSide } from './sider/FagSide';
import { ProsjektListe } from './sider/ProsjektListe';
import { ProsjektSide } from './sider/ProsjektSide';

/**
 * Ramme med toppmeny. Innlogget bruker kommer fra serveren. I utvikling kan man bytte bruker
 * (f.eks. til sidemann) med e-postfeltet; i produksjon erstattes dette av Entra ID.
 */
export function App() {
  const [bruker, setBruker] = useState<{ navn: string; epost: string } | null>(null);
  const [feil, setFeil] = useState<string | null>(null);

  useEffect(() => {
    api.get('/meg').then(setBruker, (e: Error) => setFeil(e.message));
  }, []);

  const byttBruker = () => {
    const epost = prompt('Logg inn som (e-post, kun i utvikling):', bruker?.epost ?? '');
    if (epost === null) return;
    try {
      if (epost) localStorage.setItem('bruker-epost', epost);
      else localStorage.removeItem('bruker-epost');
    } catch {
      // Lagring blokkert; bruker standardbrukeren
    }
    location.reload();
  };

  return (
    <div className="ramme">
      <header className="topp">
        <Link to="/" className="logo">
          Tilbudsevaluering
        </Link>
        <span className="bruker">
          {bruker ? bruker.navn : feil ?? '…'}{' '}
          <button className="lenke" onClick={byttBruker}>
            bytt
          </button>
        </span>
      </header>
      <main>
        <Routes>
          <Route path="/" element={<ProsjektListe />} />
          <Route path="/prosjekter/:id" element={<ProsjektSide />} />
          <Route path="/fag/:id" element={<FagSide />} />
          <Route path="/evalueringer/:id" element={<EvalueringSide />} />
          <Route path="*" element={<p>Siden finnes ikke.</p>} />
        </Routes>
      </main>
    </div>
  );
}
