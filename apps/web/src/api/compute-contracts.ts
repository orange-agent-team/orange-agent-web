import { Ajv2020 } from 'ajv/dist/2020.js';
import artifacts from '../../../../docs/contracts/artifacts.schema.json' with { type: 'json' };
import models from '../../../../docs/contracts/models.schema.json' with { type: 'json' };
import pricing from '../../../../docs/contracts/pricing.schema.json' with { type: 'json' };
export const TRANSCRIPTION_MEDIA = 'application/vnd.orange.transcription+json';
export const MODEL_RESPONSE_MEDIA = 'application/vnd.orange.model-response+json';
export interface Artifact { upload_id: string; artifact_id: string; version_id: string; owner_id: string; sha256: string; size_bytes: string; media_type: string; state: 'staging' | 'available' | 'deleted' }
export type AudioMedia = 'audio/wav' | 'audio/flac' | 'audio/mpeg' | 'audio/ogg' | 'audio/mp4';
export interface InspectedImage {
 artifact_id: string; version_id: string;
 content: {width: 1024; height: 1024; media_type: 'image/png'; bytes: number; sha256: string; rgb_sha256: string};
}
export interface ArtifactRetention {
 artifact_id: string; version_id: string;
 basis: 'staging'|'published'|'last_reference_released'|'response_commit'|'migration_grace'|'active_reference'|'deleted';
 anchor_unix: string|null; due_unix: string|null; protected_by_reference: boolean;
}
export interface AudioMeasurement {
 artifact_id: string; version_id: string; audio_sha256: string; model_version: string; preprocessing: string;
 format: string; codec: string; source_sample_rate: number; source_samples: string; normalized_samples: string;
 normalized_sha256: string; duration_ms: string;
}
export interface AudioTarget { observation_id: string; node_id: string; region_id: string; model_version: string; execution_profile_digest: string }
export interface AudioGrantRequest extends Omit<AudioTarget,'model_version'> {
 grant_id:string; invocation_id:string; root_budget_id:string; upload_id:string; language:string|null;
 ttl_seconds:number; allow_remote_transcription:true; measurement:AudioMeasurement;
}
export interface AudioGrantReceipt {
 grant_id:string; invocation_id:string; observation_id:string; projection_digest:string; expires_at_unix:string;
 state:'active'|'revoked'|'expired';
}
export interface AudioPrice { price_version:string; price_per_minute:string; fee_bps:number }
export interface AudioQuote extends AudioPrice {quote_id:string; grant_id:string; root_budget_id:string; invocation_id:string; request_projection_digest:string; observation_id:string; duration_ms:string; max_amount:string; expires_at_unix:string}
export interface AudioWithdrawal {grant_id:string; state:'revoked'}
export interface TranscriptionResult {
 version:1; request_projection_digest:string; execution_profile_digest:string; measurement:AudioMeasurement;
 language:string; language_probability:number; compute_type:'int8'|'int8_float32';
 segments:{start_ms:number;end_ms:number;text:string}[];text:string;
}
export interface Upload { upload_id: string; sha256: string; size_bytes: string; media_type: 'application/json'|'text/plain'|AudioMedia }
export interface Price { price_version: string; model_version: string; node_id: string; meter_profile_digest: string; input_price: string; output_price: string; output_limit: string; fee_bps: number }
export interface ReviewedModel {
 modality: 'text'; model_version: string; model_sha256: string; repository: string; revision: string;
 license: string; context_tokens: number; max_request_bytes: number; offers: Price[];
}
export interface MarketModelList { data: ReviewedModel[] }
export interface QuoteRequest { request_id: string; root_budget_id: string; price_version: string; input_upload_id: string; input_version_id: string; output_limit: number }
export interface QuoteFunding {
 quote_id:string;requester_id:string;owner_id:string;root_budget_id:string;account_kind:'personal'|'team';price_version:string;
 max_microcredits:string;budget_limit:string;budget_spent:string;budget_reserved:string;budget_remaining:string;
 wallet_available:string|null;status:'sufficient'|'expired'|'budget_closed'|'spending_paused'|'insufficient_budget'|'insufficient_funds';
 observed_unix:string;expires_unix:string;
}
export interface Quote { quote_id: string; root_budget_id: string; invocation_id: string; price_version: string; request_projection_digest: string; meter_profile_digest: string; input_units: string; output_limit: string; max_amount: string; expires_at_unix: string }
export interface Submission { root_budget_id: string; invocation_id: string; purpose: 'primary' | 'summary' | 'memory' | 'title' | 'continuation' | 'transcription'; quote_id: string; request_projection_digest: string }
export interface Job { job_id: string; root_budget_id: string; invocation_id: string; execution_state: 'queued' | 'running' | 'cancelling' | 'succeeded' | 'failed' | 'cancelled'; settlement_state: 'pending' | 'settled' | 'reversed'; reserved: string; charge: string | null }
export interface JobPage { owner_id: string; user_id: string; data: Job[]; next_cursor: string | null }
export interface JobLookup { owner_id: string; user_id: string; quote_id: string; job: Job }
export interface Withdrawal { owner_id:string; user_id:string; invocation_id:string; quote_id:string; prevented:boolean; receipt_id:string|null; job:Job|null }
export interface InputBinding { job_id: string; artifact_id: string; version_id: string; sha256: string; size_bytes: string; projection_digest: string }
export interface Result { response_id: string; text: string; tool_calls: { id: string; name: string; arguments: Record<string, unknown> }[]; native_usage: { input_tokens: number; output_tokens: number } | null; finish_reason: 'stop' | 'tool_calls' }
export interface JobEventCursor { stream_id:string; after:string }
export interface JobEvent { event_id:string; seq:string; event_type:string; attempt_id:string|null; occurred_at:string; payload_digest:string }
export type JobHistory = {kind:'snapshot'|'reset';job:Job;job_version:string;cursor:JobEventCursor|null} |
 {kind:'page';job_id:string;cursor:JobEventCursor;events:JobEvent[]};
export interface JobStreamFrame { protocol_version:1; connection_generation:string; history:JobHistory }
const ajv = new Ajv2020({ strict: false }); ajv.addSchema(artifacts); ajv.addSchema(pricing); ajv.addSchema(models);
const compile = <T,>(schema: { $id: string }, name: string) => ajv.compile<T>({ $ref: `${schema.$id}#/$defs/${name}` });
export const isJobStreamFrame=compile<JobStreamFrame>(artifacts,'JobStreamFrame');
export const isArtifactError=compile<{code:string;message:string;request_id:string;retry_class:string}>(artifacts,'ApiError');
const validators = {
 Retention: compile<ArtifactRetention>(artifacts,'ArtifactRetentionView'),
 Models: compile<MarketModelList>(models, 'MarketModelList'),
 Funding: compile<QuoteFunding>(pricing,'QuoteFundingView'),
 AudioPrice: compile<AudioPrice>(artifacts,'TranscriptionPrice'),
 AudioQuote: compile<AudioQuote>(artifacts,'TranscriptionQuoteView'),
 AudioSubmission: compile<Submission>(artifacts,'SubmitTranscriptionJob'),
 TranscriptionResult: compile<TranscriptionResult>(artifacts,'TranscriptionResult'),
 AudioTarget: compile<AudioTarget>(artifacts,'TranscriptionInputTarget'),
 AudioGrantRequest: compile<AudioGrantRequest>(artifacts,'CreateTranscriptionInputGrant'),
 AudioGrantReceipt: compile<AudioGrantReceipt>(artifacts,'TranscriptionGrantReceipt'),
 AudioWithdrawal: compile<AudioWithdrawal>(artifacts,'TranscriptionInputWithdrawal'),
 AudioMeasurement: compile<AudioMeasurement>(artifacts, 'AudioMeasurement'),
 InspectedImage: compile<InspectedImage>(artifacts, 'InspectedImage'),
 Artifact: compile<Artifact>(artifacts, 'ArtifactView'), Upload: compile<Upload>(artifacts, 'CreateUpload'),
 Price: compile<Price>(pricing, 'TextPriceView'), QuoteRequest: compile<QuoteRequest>(pricing, 'CreateTextQuote'), Quote: compile<Quote>(pricing, 'TextQuoteView'),
 Submission: compile<Submission>(artifacts, 'SubmitTextJob'), Job: compile<Job>(artifacts, 'JobView'), JobPage: compile<JobPage>(artifacts, 'UserJobList'), JobLookup: compile<JobLookup>(artifacts, 'UserJobLookup'), Withdrawal: compile<Withdrawal>(artifacts,'InvocationWithdrawal'), InputBinding: compile<InputBinding>(artifacts, 'JobInputView'), Result: compile<Result>(artifacts, 'ModelResponseCandidate'),
};
type Values = { InspectedImage: InspectedImage; Retention:ArtifactRetention; Models:MarketModelList; Funding:QuoteFunding; AudioPrice:AudioPrice; AudioQuote:AudioQuote; AudioSubmission:Submission; TranscriptionResult:TranscriptionResult; AudioTarget:AudioTarget; AudioGrantRequest:AudioGrantRequest; AudioGrantReceipt:AudioGrantReceipt; AudioWithdrawal:AudioWithdrawal; AudioMeasurement: AudioMeasurement; Artifact: Artifact; Upload: Upload; Price: Price; QuoteRequest: QuoteRequest; Quote: Quote; Submission: Submission; Job: Job; JobPage: JobPage; JobLookup: JobLookup; Withdrawal: Withdrawal; InputBinding: InputBinding; Result: Result };
const monetary = new Set(['price_per_minute', 'input_price', 'output_price', 'max_amount', 'reserved', 'charge']);
export function decodeCompute<K extends keyof Values>(kind: K, value: unknown): Values[K] {
 if (!validators[kind](value)) throw new Error('INVALID_COMPUTE_RESPONSE');
 const inspect = (item: unknown): void => {
  if (item !== null && typeof item === 'object') {
   for (const [key, entry] of Object.entries(item)) {
    if (monetary.has(key) && entry !== null && (typeof entry !== 'string' || !/^(0|[1-9][0-9]*)$/.test(entry) || BigInt(entry) > 9223372036854775807n)) throw new Error('INVALID_COMPUTE_MONEY');
    if (typeof entry === 'object') inspect(entry);
   }
   if ('execution_state' in item) { const job = item as Job; if (job.charge !== null && BigInt(job.charge) > BigInt(job.reserved)) throw new Error('INVALID_JOB_CHARGE'); }
  }
 };
 // Tool arguments are untrusted arbitrary objects, never financial metadata.
 if (kind !== 'Result') inspect(value);
 if (kind === 'Price' && BigInt((value as Price).output_limit) > 4096n) throw new Error('UNSUPPORTED_OUTPUT_LIMIT');
 return value as Values[K];
}
export function pathId(value: string): string {
 if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)) throw new Error('INVALID_ID');
 return encodeURIComponent(value);
}
export async function sha256(bytes: Uint8Array): Promise<string> {
 const owned = new Uint8Array(bytes.byteLength); owned.set(bytes);
 return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', owned.buffer)), b => b.toString(16).padStart(2,'0')).join('');
}
export function modelInput(invocation: string, model: string, text: string, output: number): Uint8Array {
 pathId(invocation); pathId(model);
 if (!text.trim() || !Number.isInteger(output) || output < 1 || output > 4096) throw new Error('INVALID_MODEL_INPUT');
 const encoder = new TextEncoder(); if (new TextDecoder('utf-8', { fatal: true }).decode(encoder.encode(text)) !== text) throw new Error('INVALID_UNICODE');
 const bytes = encoder.encode(JSON.stringify({ invocation_id: invocation, model_version: model, messages: [{ role: 'user', content: text }], tools: [], max_output_tokens: output }));
 if (bytes.length > 262144) throw new Error('MODEL_INPUT_TOO_LARGE'); return bytes;
}
