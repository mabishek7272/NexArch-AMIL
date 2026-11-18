import React, { useEffect, useRef, useState } from 'react';
/** Lazy, same-origin adapter. No CDN, workers, eval, provider URL fetching or PyMOL.
 * 3Dmol 2.5.5 BSD-3-Clause. PDB/mmCIF are read from our hash-verified artifact API.
 */
export default function MolecularViewer({
  sourceId,
  format,
}: {
  sourceId: string;
  format: string;
}) {
  const el = useRef<HTMLDivElement>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let viewer: any;
    let cancelled = false;
    const controller = new AbortController();
    setLoading(true);
    setError('');
    (async () => {
      if (!['pdb', 'mmcif'].includes(format))
        throw new Error('Preview supports PDB and mmCIF; use the artifact table for bCIF.');
      const canvas = document.createElement('canvas');
      if (!canvas.getContext('webgl2') && !canvas.getContext('webgl'))
        throw new Error(
          'WebGL is unavailable. Structure metadata and confidence tables remain available.',
        );
      const module = await import('3dmol');
      const response = await fetch(`/api/science/sources/${encodeURIComponent(sourceId)}/content`, {
        credentials: 'include',
        signal: controller.signal,
      });
      if (!response.ok) throw new Error('Unable to load the verified structure artifact.');
      const text = await response.text();
      if (cancelled || !el.current) return;
      viewer = module.createViewer(el.current, { backgroundColor: '#101217' });
      viewer.addModel(text, format === 'mmcif' ? 'cif' : 'pdb');
      viewer.setStyle(
        {},
        {
          cartoon: {
            colorfunc: (atom: { b?: number }) => {
              const v = atom.b;
              return v == null
                ? '#9298a5'
                : v >= 90
                  ? '#1767bb'
                  : v >= 70
                    ? '#55b8da'
                    : v >= 50
                      ? '#edb957'
                      : '#df7656';
            },
          },
        },
      );
      viewer.zoomTo();
      viewer.render();
      setLoading(false);
    })().catch((e: Error) => {
      if (!cancelled) {
        setLoading(false);
        setError(e.message);
      }
    });
    return () => {
      cancelled = true;
      controller.abort();
      viewer?.clear();
    };
  }, [sourceId, format]);
  return (
    <section aria-label="Molecular viewer">
      <p>
        Predicted structure · pLDDT colours: blue ≥90, cyan 70–90, amber 50–70, orange &lt;50. These
        are descriptive confidence bands, not acceptance criteria.
      </p>
      {loading && <p role="status">Loading molecular viewer…</p>}
      {error && <p role="status">{error}</p>}
      <div
        ref={el}
        style={{ height: error ? 0 : 330, position: 'relative' }}
        aria-label="Interactive 3D structure; use the residue and metadata tables below for an accessible alternative"
      />
    </section>
  );
}
