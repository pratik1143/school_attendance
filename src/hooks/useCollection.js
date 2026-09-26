import { useCallback, useEffect, useState } from 'react';
export function useCollection(loader, deps = [], subscribe, enabled = true) {
  const [data, setData] = useState([]); const [loading, setLoading] = useState(true); const [error, setError] = useState('');
  const reload = useCallback(async () => { setLoading(true); setError(''); try { setData(await loader()); } catch (e) { setError(e?.message || 'Could not load data.'); } finally { setLoading(false); } }, deps);
  useEffect(() => {
    if (!enabled) { setData([]); setError(''); setLoading(false); return undefined; }
    if (!subscribe) { reload(); return undefined; }
    setLoading(true); setError('');
    return subscribe((rows) => { setData(rows); setError(''); setLoading(false); }, (e) => { setError(e?.message || 'Could not load data.'); setLoading(false); });
  }, [reload, subscribe, enabled]);
  return { data, loading, error, reload };
}
