import type {ComputeClient} from '../api/compute-client';
import type {UserSession} from '../api/contracts';
import ArtifactRetentionDetails from './ArtifactRetentionDetails';
type Document=Awaited<ReturnType<ComputeClient['resultDocument']>>;
export default function TaskDocument({document,api,session}:{document:Document;api:ComputeClient;session:UserSession}){
  return <><ArtifactRetentionDetails api={api} session={session} artifact={document.artifact} label="结果保留期限" /><pre data-testid="model-result-text">{document.text}</pre>
    {document.kind==='transcription'&&<details><summary>查看转写时间段</summary>
      <p>语言 {document.transcript.language} · 解码时长 {document.transcript.measurement.duration_ms} 毫秒</p>
      <ol>{document.transcript.segments.map((segment,i)=><li key={i}><span>{segment.start_ms}–{segment.end_ms} 毫秒</span> {segment.text}</li>)}</ol>
    </details>}</>;
}
