import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Alert, Button, Card, Input } from 'antd';
import { Link } from 'react-router';
import { ApiFailure } from '../api/client';
import { ComputeClient } from '../api/compute-client';
import type { InspectedImage } from '../api/compute-contracts';
import type { UserSession } from '../api/contracts';

export function ImageOutputInspection({ api, session, invalidate, sharingHref }: {
  api: ComputeClient; session: UserSession; invalidate: () => void; sharingHref?: (resource:string) => string;
}) {
  const [upload, setUpload] = useState('');
  const [result, setResult] = useState<InspectedImage>();
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const active = useRef<AbortController | null>(null);

  const clear = useCallback(() => {
    active.current?.abort();
    active.current = null;
    setResult(undefined);
    setPending(false);
    setError('');
  }, []);
  useEffect(() => {
    const retire = () => { clear(); setUpload(''); };
    const hide = () => { if (document.hidden) retire(); };
    document.addEventListener('visibilitychange', hide);
    window.addEventListener('offline', retire);
    return () => {
      document.removeEventListener('visibilitychange', hide);
      window.removeEventListener('offline', retire);
      active.current?.abort();
      active.current = null;
    };
  }, [clear]);
  useEffect(() => {
    if (!result) return;
    const timer = window.setTimeout(clear, 15000);
    return () => window.clearTimeout(timer);
  }, [result, clear]);

  async function inspect(event: FormEvent) {
    event.preventDefault();
    clear();
    const current = new AbortController();
    active.current = current;
    setPending(true);
    try {
      const next = await api.inspectImage(session, upload.trim(), current.signal);
      if (active.current === current && !document.hidden) setResult(next);
    } catch (reason) {
      if (active.current !== current) return;
      if (reason instanceof ApiFailure && reason.status === 401) { invalidate(); return; }
      setError('无法核对该图像，请检查上传记录 ID、内容权限和文件格式。');
    } finally {
      if (active.current === current) { active.current = null; setPending(false); }
    }
  }

  return <Card><details onToggle={event => { if (!event.currentTarget.open) clear(); }}>
    <summary>核对已存图像</summary>
    <form onSubmit={inspect}>
      <label>图像上传记录 ID
        <Input value={upload} maxLength={128} onChange={event => { clear(); setUpload(event.target.value); }} />
      </label>
      <Button htmlType="submit" loading={pending} disabled={!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(upload.trim())}>
        校验 PNG
      </Button>
    </form>
    {error && <Alert type="error" title={error} />}
    {result && <dl aria-label="图像校验结果">
      <dt>资源 ID</dt><dd>{result.artifact_id} {sharingHref && <Link to={sharingHref(result.artifact_id)}>管理共享权限</Link>}</dd>
      <dt>版本</dt><dd>{result.version_id}</dd>
      <dt>图像</dt><dd>{result.content.width} × {result.content.height} RGB PNG · {result.content.bytes} 字节</dd>
      <dt>文件 SHA-256</dt><dd><code>{result.content.sha256}</code></dd>
      <dt>像素 SHA-256</dt><dd><code>{result.content.rgb_sha256}</code></dd>
    </dl>}
  </details></Card>;
}
