import { createHash } from 'node:crypto';
const measuredAudits = new WeakSet<object>();
export function isMeasuredHttpByteAudit(value: unknown): value is HttpByteAudit { return value !== null && typeof value === 'object' && measuredAudits.has(value); }
export const HTTP_AUDIT_MAX_BYTES = 8 * 1024 * 1024;
export interface AuditHttpRequest { method: 'GET' | 'HEAD'; headers: Readonly<Record<string, string>> }
export interface AuditHttpResponse { status: number; headers: Readonly<Record<string, string>>; body: Uint8Array }
export interface HttpByteAuditRow { id: string; expectedStatus: number; status: number; expectedLength: number; bodyLength: number; mismatchBytes: number; headersValid: boolean }
export interface HttpByteAudit { method: 'fixed-source-full-and-ranges-v1'; sourceDigest: string; sourceBytes: number; rows: HttpByteAuditRow[]; verified: boolean }
/** 仅私有有界审计。调用端口拥有实际HTTP/取消收口，公开端不接受URL、token或path。 */
export async function auditHttpBytes(source: Uint8Array, request: (input: AuditHttpRequest) => Promise<AuditHttpResponse>): Promise<HttpByteAudit> {
  if (!(source instanceof Uint8Array) || source.length < 1 || source.length > HTTP_AUDIT_MAX_BYTES) throw new Error('字节审计源超过8MiB或不是有效字节。');
  const oracle = Uint8Array.from(source), size = oracle.length, middle = Math.floor(size / 2), width = Math.min(17,size);
  const cases:readonly {id:string;method:'GET'|'HEAD';headers:Readonly<Record<string,string>>;status:number;start:number;end:number}[] = [
    {id:'full',method:'GET',headers:{},status:200,start:0,end:size-1},
    {id:'head',method:'HEAD',headers:{},status:200,start:0,end:size-1},
    {id:'first',method:'GET',headers:{Range:`bytes=0-${width-1}`},status:206,start:0,end:width-1},
    {id:'middle',method:'GET',headers:{Range:`bytes=${middle}-${Math.min(size-1,middle+width-1)}`},status:206,start:middle,end:Math.min(size-1,middle+width-1)},
    {id:'last',method:'GET',headers:{Range:`bytes=${size-width}-${size-1}`},status:206,start:size-width,end:size-1},
    {id:'open',method:'GET',headers:{Range:`bytes=${middle}-`},status:206,start:middle,end:size-1},
    {id:'suffix',method:'GET',headers:{Range:`bytes=-${width}`},status:206,start:size-width,end:size-1},
    {id:'single',method:'GET',headers:{Range:'bytes=0-0'},status:206,start:0,end:0},
    ...['W/"stat-evidence"','"not-a-certified-content-validator"','Wed, 01 Jan 2025 00:00:00 GMT'].map((value,index)=>({id:`if-range-${index}`,method:'GET' as const,headers:{Range:'bytes=0-0','If-Range':value},status:200,start:0,end:size-1})),
    {id:'outside',method:'GET',headers:{Range:`bytes=${size}-`},status:416,start:0,end:-1},
    {id:'multiple',method:'GET',headers:{Range:'bytes=0-0,2-2'},status:400,start:0,end:-1},
    {id:'invalid',method:'GET',headers:{Range:'bytes=9-2'},status:400,start:0,end:-1},
  ] as const;
  const rows: HttpByteAuditRow[] = [];
  for (const item of cases) {
    let response:AuditHttpResponse;
    try { response = await request({method:item.method,headers:item.headers}); }
    catch { response = {status:0,headers:{},body:new Uint8Array()}; }
    if (!(response.body instanceof Uint8Array) || response.body.length > HTTP_AUDIT_MAX_BYTES) throw new Error('HTTP审计响应超过有界预算。');
    const headers = Object.fromEntries(Object.entries(response.headers).map(([key,value])=>[key.toLowerCase(),value]));
    const expected = item.method === 'HEAD' || item.status >= 400 ? new Uint8Array() : oracle.subarray(item.start,item.end+1);
    let mismatchBytes = Math.abs(expected.length-response.body.length);
    for (let i=0;i<Math.min(expected.length,response.body.length);i++) if(expected[i]!==response.body[i])mismatchBytes++;
    const expectedLength = item.method==='HEAD'?size:expected.length;
    const headersValid = headers['content-length']===String(expectedLength)
      && (item.status===206 ? headers['content-range']===`bytes ${item.start}-${item.end}/${size}` : item.status===416 ? headers['content-range']===`bytes */${size}` : headers['content-range']===undefined)
      && (item.status>=400 || headers['accept-ranges']==='bytes' && headers['cache-control']==='no-store' && /^W\//u.test(headers.etag ?? ''));
    rows.push({id:item.id,expectedStatus:item.status,status:response.status,expectedLength,bodyLength:response.body.length,mismatchBytes,headersValid});
  }
  const report:HttpByteAudit = {method:'fixed-source-full-and-ranges-v1',sourceDigest:createHash('sha256').update(oracle).digest('hex'),sourceBytes:size,rows,
    verified:rows.every(row=>row.status===row.expectedStatus && row.mismatchBytes===0 && row.headersValid)};
  rows.forEach(Object.freeze);Object.freeze(rows);Object.freeze(report);measuredAudits.add(report);return report;
}
