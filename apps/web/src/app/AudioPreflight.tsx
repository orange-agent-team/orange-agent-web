import { useEffect, useMemo,useRef, useState } from 'react';
import { Link } from 'react-router';
import { Alert, Button, Card, Input, Typography } from 'antd';
import { ApiFailure } from '../api/client';
import { ComputeClient } from '../api/compute-client';
import { pathId, sha256, type AudioMeasurement, type AudioMedia } from '../api/compute-contracts';
import type { UserSession } from '../api/contracts';

import AudioInputConsent from './AudioInputConsent';


const formats: Record<string, AudioMedia> = { wav:'audio/wav', flac:'audio/flac', mp3:'audio/mpeg', ogg:'audio/ogg', opus:'audio/ogg', m4a:'audio/mp4' };
type Selection = { file: File; media: AudioMedia; upload: string };

export default function AudioPreflight({ session, invalidate,ownerId,budgetId }: { session: UserSession; invalidate: () => void;ownerId?:string;budgetId?:string }) {
  const api=useMemo(()=>new ComputeClient(undefined,ownerId),[ownerId]);
  const [selection, setSelection] = useState<Selection>();
  const [upload, setUpload] = useState('');
  const [pending, setPending] = useState(false);
  const [receipt, setReceipt] = useState<AudioMeasurement>();
  const [error, setError] = useState('');
  const active = useRef<AbortController | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const clear = () => { active.current?.abort(); active.current = null; setPending(false); setReceipt(undefined); setError(''); };
  useEffect(() => {
    const hide = () => { if (document.hidden) clear(); };
    document.addEventListener('visibilitychange', hide);
    return () => { document.removeEventListener('visibilitychange', hide); active.current?.abort(); };
  }, []);
  useEffect(() => {
    if (!receipt) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function check() {
      if (!receipt) return;
      try {
        const artifact = await api.uploadStatus(session, upload, controller.signal);
        if (artifact.state !== 'available' || artifact.version_id !== receipt.version_id ||
            artifact.artifact_id !== receipt.artifact_id || artifact.sha256 !== receipt.audio_sha256) throw new Error('SOURCE_CHANGED');
        if (!controller.signal.aborted) timer = setTimeout(() => void check(), 5000);
      } catch (failure) {
        if (!controller.signal.aborted) {
          setReceipt(undefined); setError('当前无法确认源音频的读取权限。');
          if (failure instanceof ApiFailure && failure.status === 401) invalidate();
        }
      }
    }
    timer = setTimeout(() => void check(), 5000);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [session, receipt, upload, invalidate]);
  function select(file?: File) {
    clear(); setUpload(''); setSelection(undefined);
    if (!file) return;
    const media = formats[file.name.split('.').pop()?.toLowerCase() ?? ''];
    if (!media || !file.size || file.size > 100000000) { setError('请选择支持的音频文件，大小上限为 100 MB。'); return; }
    const id = crypto.randomUUID();
    setSelection({ file, media, upload:id }); setUpload(id);
  }
  async function measure() {
    if (active.current) return;
    const controller = new AbortController(); active.current = controller;
    setPending(true); setReceipt(undefined); setError('');
    try {
      pathId(upload);
      let artifact;
      if (selection) {
        const hash = await sha256(new Uint8Array(await selection.file.arrayBuffer()));
        controller.signal.throwIfAborted();
        const request = { upload_id:selection.upload, sha256:hash, media_type:selection.media, size_bytes:String(selection.file.size) };
        artifact = await api.beginUpload(session, request, controller.signal);
        if (artifact.state === 'staging') artifact = await api.putAudio(session, request, selection.file, controller.signal);
      } else {
        artifact = await api.uploadStatus(session, upload, controller.signal);
      }
      const result = await api.measureAudio(session, artifact, controller.signal);
      if (!controller.signal.aborted) setReceipt(result);
    } catch (failure) {
      if (!controller.signal.aborted) {
        if (failure instanceof ApiFailure && failure.status === 401) invalidate();
        else if (failure instanceof ApiFailure && failure.status === 403) setError('当前账户已无权读取这份音频或会话已失效。');
        else if (failure instanceof ApiFailure && failure.status === 503) setError('服务端音频预检暂不可用。');
        else setError('预检未完成。请确认音频格式、对象状态和上传编号后重试。');
      }
    } finally { if (active.current === controller) { active.current=null; setPending(false); } }
  }
  return <>
    <Link to={ownerId?'/organizations/'+pathId(ownerId)+'/tasks':'/tasks'}>返回模型任务</Link>
    <div className="page-heading"><h1>音频预检</h1></div>
    <Card title="选择音频">
      <p>上传目的地为{ownerId?'团队空间':'个人空间'} <code>{ownerId??session.personal_owner_id}</code>。选择文件后可先核对范围；点击上传时平台将收到原音频并测量时长。此次预检免费。</p>
      {selection&&<p aria-label="待上传音频">待上传文件 {selection.file.name} · {selection.file.size} 字节 · {selection.media}</p>}
      <label>本地文件 <input ref={picker} type="file" accept=".wav,.flac,.mp3,.ogg,.opus,.m4a" disabled={pending} onChange={event => select(event.target.files?.[0])} /></label>
      <p><label>上传编号<Input value={upload} disabled={pending} onChange={event => {
        clear(); setSelection(undefined); setUpload(event.target.value); if (picker.current) picker.current.value='';
      }} /></label></p>
      <Button type="primary" disabled={!upload || pending} loading={pending} onClick={() => void measure()}>{selection ? '上传并预检' : '预检已有音频'}</Button>
      {error && <Alert type="error" title={error} />}
    </Card>
    {receipt && <Card title="预检结果"><dl>
      <dt>解码时长</dt><dd>{receipt.duration_ms} 毫秒</dd>
      <dt>音频编码</dt><dd>{receipt.codec}</dd>
      <dt>源采样</dt><dd>{receipt.source_samples} 个采样点，{receipt.source_sample_rate} Hz</dd>
      <dt>对象版本</dt><dd><Typography.Text copyable>{receipt.version_id}</Typography.Text></dd>
    </dl></Card>}
    <AudioInputConsent api={api} initialBudget={budgetId} session={session} upload={upload} measurement={receipt} />
  </>;
}
