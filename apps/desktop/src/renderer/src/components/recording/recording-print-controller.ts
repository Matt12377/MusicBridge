import { isRecordingPrintsPage, isRecordingPrintJob, isRecordingPrintResult, isExportRecordingPrintResult, type RecordingPrintsPublicApi, type RecordingRecordDetail, type RecordingPrintsPage, type RecordingPrintJob, type RecordingPrintResult, type RequestRecordingPrintRequest, type RetryRecordingPrintRequest } from '@music-bridge/contracts';
import { artworkImageSha256 } from './master-artwork-controller';
type Pending = {
    kind: 'request';
    request: RequestRecordingPrintRequest;
} | {
    kind: 'retry';
    request: RetryRecordingPrintRequest;
};
export interface RecordingPrintState {
    listPhase: 'unread' | 'loading' | 'ready' | 'error';
    page?: RecordingPrintsPage;
    selectedId: string;
    detailPhase: 'unread' | 'loading' | 'ready' | 'error';
    result?: RecordingPrintResult;
    confirmed: boolean;
    sending: boolean;
    pending?: Pending;
    exportPhase: 'idle' | 'pending' | 'cancelled' | 'exported' | 'unknown';
    error: string;
    detailError: string;
    notice: string;
}
export function createRecordingPrintController(options: {
    api: RecordingPrintsPublicApi;
    detail: RecordingRecordDetail;
    onChange?: () => void;
}) {
    const { api, detail } = options, state: RecordingPrintState = { listPhase: 'unread', selectedId: '', detailPhase: 'unread', confirmed: false, sending: false, exportPhase: 'idle', error: '', detailError: '', notice: '' };
    let alive = true, listToken = 0, detailToken = 0, lastJob: RecordingPrintJob | undefined;
    const emit = () => { if (alive)
        options.onChange?.(); }, blocked = () => state.sending || !!state.pending || state.exportPhase === 'pending', matches = (job: RecordingPrintJob) => job.request.recordingId === detail.record.id && job.request.recordingContentHash === detail.record.contentHash && job.request.planVersionId === detail.plan.id && job.request.planContentHash === detail.plan.contentHash;
    async function refresh(offset = 0) { if (!alive || blocked())
        return; const token = ++listToken; state.listPhase = 'loading'; state.error = ''; emit(); try {
        const value = await api.listRecordingPrints({ recordingId: detail.record.id, page: { offset, limit: 25 } });
        if (!alive || token !== listToken)
            return;
        if (!isRecordingPrintsPage(value) || value.offset !== offset || value.limit !== 25 || !value.items.every(matches))
            throw new Error('IDENTITY');
        state.page = { ...value, items: value.items.map(job => lastJob?.id === job.id && lastJob.revision > job.revision ? lastJob : job) };
        state.listPhase = 'ready';
    }
    catch {
        if (alive && token === listToken) {
            state.listPhase = 'error';
            state.page = undefined;
            state.error = '印刷文件列表读取失败；不表示没有历史文件，请明确重试。';
        }
    } emit(); }
    async function select(artifactId: string) { if (!alive || blocked())
        return; const job = state.page?.items.find(j => j.state === 'ready' && j.artifactId === artifactId); if (!job)
        return; const token = ++detailToken; state.selectedId = artifactId; state.result = undefined; state.detailPhase = 'loading'; state.detailError = ''; state.exportPhase = 'idle'; state.confirmed = false; emit(); try {
        const value = await api.getRecordingPrint({ recordingId: detail.record.id, artifactId });
        if (!alive || token !== detailToken)
            return;
        if (!isRecordingPrintResult(value) || value.artifact.id !== artifactId || value.artifact.requestId !== job.request.id || value.artifact.inputHash !== job.request.inputHash || value.artifact.templateHash !== job.request.templateHash || value.facts.recordingId !== detail.record.id || value.facts.recordingContentHash !== detail.record.contentHash || value.facts.planVersionId !== detail.plan.id || value.facts.planContentHash !== detail.plan.contentHash || await artworkImageSha256(value.preview) !== value.artifact.previewSha256)
            throw new Error('IDENTITY');
        if (!alive || token !== detailToken)
            return;
        state.result = value;
        state.detailPhase = 'ready';
    }
    catch {
        if (alive && token === detailToken) {
            state.detailPhase = 'error';
            state.detailError = '此印刷文件读取或完整性核对失败；未用当前模板重建替代，请重试。';
        }
    } emit(); }
    async function send() { const pending = state.pending; if (!alive || !pending || state.sending)
        return; state.sending = true; state.error = ''; listToken++; detailToken++; emit(); try {
        const job = pending.kind === 'request' ? await api.requestRecordingPrint(structuredClone(pending.request)) : await api.retryRecordingPrint(structuredClone(pending.request));
        if (!alive)
            return;
        if (!isRecordingPrintJob(job) || !matches(job) || pending.kind === 'retry' && (job.id !== pending.request.jobId || job.revision <= pending.request.expectedRevision))
            throw new Error('INVALID_RECEIPT');
        lastJob = job;
        state.pending = undefined;
        state.confirmed = false;
        state.result = undefined;
        state.selectedId = '';
        state.detailPhase = 'unread';
        state.notice = '打印请求已登记；请刷新查看生成状态。未打印纸张，也未自动导出。';
        state.page = undefined;
        state.listPhase = 'unread';
    }
    catch {
        if (alive)
            state.error = '打印操作回执尚未确认；可以重试原操作，不会自动重放。';
    }
    finally {
        if (alive) {
            state.sending = false;
            emit();
        }
    } }
    async function request() { if (!alive || blocked() || !state.confirmed || detail.record.schemaVersion !== 1 || detail.plan.layout.spec.format !== 'cassette')
        return; state.pending = { kind: 'request', request: { commandId: crypto.randomUUID(), recordingId: detail.record.id, expectedRecordHash: detail.record.contentHash, templateId: 'jp0-basic-v1', userConfirmed: true } }; await send(); }
    async function retry(jobId: string) { if (!alive || blocked() || !state.confirmed)
        return; const job = state.page?.items.find(j => j.id === jobId && j.state === 'failed'); if (!job)
        return; state.pending = { kind: 'retry', request: { commandId: crypto.randomUUID(), jobId, expectedRevision: job.revision, userConfirmed: true } }; await send(); }
    async function exportPdf() { const result = state.result; if (!alive || blocked() || !result || state.detailPhase !== 'ready')
        return; const token = detailToken; state.exportPhase = 'pending'; state.notice = '等待保存位置或导出回执；关闭面板不表示导出已取消。'; emit(); try {
        const value = await api.exportRecordingPrint({ recordingId: detail.record.id, artifactId: result.artifact.id, expectedPdfSha256: result.artifact.pdfSha256 });
        if (!alive || token !== detailToken)
            return;
        if (!isExportRecordingPrintResult(value) || value.state === 'exported' && (value.artifactId !== result.artifact.id || value.pdfSha256 !== result.artifact.pdfSha256 || value.size !== result.artifact.size))
            throw new Error('IDENTITY');
        state.exportPhase = value.state;
        state.notice = value.state === 'cancelled' ? '已取消导出；未创建本次导出文件，已保存的印刷文件不变。' : 'PDF 已导出；这不表示纸张已打印或已装盒。';
    }
    catch {
        if (alive && token === detailToken) {
            state.exportPhase = 'unknown';
            state.notice = '导出结果未确认；不会自动重放保存对话框，不能断言文件已写入或未写入。';
        }
    } emit(); }
    return { state, refresh, select, request, retry, retryPending: send, exportPdf, canClose: () => !blocked(), setConfirmed(value: boolean) { state.confirmed = value; emit(); }, abandonPending() { if (!alive || state.sending)
            return; state.pending = undefined; state.confirmed = false; state.notice = '已停止本地重试；原操作结果需刷新核对。'; emit(); }, previewFailed() { state.detailPhase = 'error'; state.detailError = '排版预览显示失败，请重新读取本份印刷文件。'; emit(); }, dispose() { alive = false; listToken++; detailToken++; } };
}
