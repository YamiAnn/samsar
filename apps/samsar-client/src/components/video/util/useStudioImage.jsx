import { useContext, useEffect, useState } from 'react';
import { useImage } from 'react-konva-utils';
import { StudioMediaContext } from '../StudioMediaContext.jsx';

export function useStudioImage(url) {
  const pool = useContext(StudioMediaContext);
  const legacyImage = useImage(pool ? undefined : url, 'anonymous');
  const [resource, setResource] = useState({ pool: null, url: null, image: null, status: 'loading' });
  useEffect(() => {
    if (!pool) return undefined;
    let active = true;
    pool.load(url).then(image => {
      if (active) setResource({ pool, url, image, status: image ? 'loaded' : 'failed' });
    });
    return () => { active = false; };
  }, [pool, url]);
  return pool ? (resource.pool === pool && resource.url === url ? [resource.image, resource.status] : [null, 'loading']) : legacyImage;
}
