import { RECORDING_PRINT_GEOMETRY, isRecordingPrintDesign, isRecordingPrintsPage, isRecordingPrintJob, isRecordingPrintResult, isExportRecordingPrintResult, isPickRecordingPrintImageResult, isMasterArtworkImage, recordingArtworkImageBytes, type CollectionPhotoImage, type RecordingPrintsPublicApi, type RecordingRecordDetail, type RecordingPrintsPage, type RecordingPrintJob, type RecordingPrintResult, type RequestRecordingPrintRequest, type RetryRecordingPrintRequest } from '@music-bridge/contracts';
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
    designTitle: string;
    designSpine: string;
    designHeightMm: string;
    designFlapMm: string;
    designSpineMm: string;
    designCoverMm: string;
    designQr: boolean;
    designImage?: CollectionPhotoImage;
    designImageSha?: string;
    designImagePhase: 'idle' | 'pending';
}
export function createRecordingPrintController(options: {
    api: RecordingPrintsPublicApi;
    detail: RecordingRecordDetail;
    onChange?: () => void;
}) {
    const { api, detail } = options, state: RecordingPrintState = { listPhase: 'unread', selectedId: '', detailPhase: 'unread', confirmed: false, sending: false, exportPhase: 'idle', error: '', detailError: '', notice: '', designTitle: detail.plan.master.title, designSpine: detail.plan.master.title, designHeightMm: String(RECORDING_PRINT_GEOMETRY.heightMm), designFlapMm: String(RECORDING_PRINT_GEOMETRY.flapMm), designSpineMm: String(RECORDING_PRINT_GEOMETRY.spineMm), designCoverMm: String(RECORDING_PRINT_GEOMETRY.coverMm), designQr: false, designImagePhase: 'idle' };
    let alive = true, listToken = 0, detailToken = 0, imageToken = 0, lastJob: RecordingPrintJob | undefined;
    const emit = () => { if (alive)
        options.onChange?.(); }, blocked = () => state.sending || !!state.pending || state.exportPhase === 'pending' || state.designImagePhase === 'pending', matches = (job: RecordingPrintJob) => job.request.recordingId === detail.record.id && job.request.recordingContentHash === detail.record.contentHash && job.request.planVersionId === detail.plan.id && job.request.planContentHash === detail.plan.contentHash;
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
        if (!isRecordingPrintResult(value) || value.artifact.id !== artifactId || value.artifact.requestId !== job.request.id || value.artifact.inputHash !== job.request.inputHash || value.artifact.templateHash !== job.request.templateHash || value.artifact.designHash !== job.request.designHash || JSON.stringify(value.design) !== JSON.stringify(job.request.design) || value.facts.recordingId !== detail.record.id || value.facts.recordingContentHash !== detail.record.contentHash || value.facts.planVersionId !== detail.plan.id || value.facts.planContentHash !== detail.plan.contentHash || await artworkImageSha256(value.preview) !== value.artifact.previewSha256
            || value.previewPages && !(await Promise.all(value.previewPages.map((image, index) => artworkImageSha256(image).then(sha => sha === value.artifact.previewPages?.[index]?.sha256)))).every(Boolean))
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
        if (!isRecordingPrintJob(job) || !matches(job) || pending.kind === 'retry' && (job.id !== pending.request.jobId || job.revision <= pending.request.expectedRevision)
            || pending.kind === 'request' && 'mode' in pending.request && (job.request.origin !== 'manual-version' || JSON.stringify(job.request.design) !== JSON.stringify(pending.request.design)))
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
    async function requestVersion() {
        if (!alive || blocked() || !state.confirmed || detail.plan.layout.spec.format !== 'cassette') return;
        const heightMm = Number(state.designHeightMm), flapMm = Number(state.designFlapMm), spineMm = Number(state.designSpineMm), coverMm = Number(state.designCoverMm);
        const round = (value: number, digits: number) => Number(value.toFixed(digits));
        const widthMm = round(flapMm + spineMm + coverMm, 4);
        const geometry = { widthMm, heightMm, widthPt: round(widthMm * 72 / 25.4, 2), heightPt: round(heightMm * 72 / 25.4, 2), flapMm, spineMm, coverMm, insideFoldMm: [coverMm, round(coverMm + spineMm, 4)] as const };
        const image = state.designImage && state.designImageSha ? { source: 'selected-image' as const, object: { sha256: state.designImageSha, size: recordingArtworkImageBytes(state.designImage), width: state.designImage.width, height: state.designImage.height } } : { source: 'recording-snapshot' as const };
        const design = { schemaVersion: 2 as const, geometry, coverTitle: state.designTitle.trim(), spineText: state.designSpine.trim(), image, qr: state.designQr ? 'recording-summary' as const : 'none' as const };
        if (!isRecordingPrintDesign(design)) { state.error = '设计值无效：标题/脊文字需 1–240 字；尺寸须在页面标出的安全范围内，三段宽度相加为 PDF 宽度。'; emit(); return; }
        state.pending = { kind: 'request', request: { commandId: crypto.randomUUID(), recordingId: detail.record.id, expectedRecordHash: detail.record.contentHash, templateId: 'jc-design-v1', userConfirmed: true, mode: 'new-version', design, ...(state.designImage ? { designImage: state.designImage } : {}) } };
        await send();
    }
    async function pickImage() {
        if (!alive || blocked() || detail.plan.layout.spec.format !== 'cassette') return;
        const token = ++imageToken; state.designImagePhase = 'pending'; state.error = ''; emit();
        try {
            const result = await api.pickRecordingPrintImage({ recordingId: detail.record.id });
            if (!alive || token !== imageToken) return;
            if (!isPickRecordingPrintImageResult(result) || result.state === 'selected' && (result.recordingId !== detail.record.id || !isMasterArtworkImage(result.image))) throw new Error('IDENTITY');
            if (result.state === 'selected') {
                const sha = await artworkImageSha256(result.image);
                if (!alive || token !== imageToken) return;
                state.designImage = result.image; state.designImageSha = sha;
                state.notice = '已选择本次设计图片；尚未写入录音档案或创建印刷版本。';
            }
        } catch { if (alive && token === imageToken) state.error = '设计图片选择未确认；原图与录音档案未修改，请核对工作库后重试。'; }
        finally { if (alive && token === imageToken) { state.designImagePhase = 'idle'; emit(); } }
    }
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
    return { state, refresh, select, request, requestVersion, pickImage, retry, retryPending: send, exportPdf, canClose: () => !blocked(), setDesignTitle(value: string) { state.designTitle = value; emit(); }, setDesignSpine(value: string) { state.designSpine = value; emit(); }, setDesignDimension(kind: 'height' | 'flap' | 'spine' | 'cover', value: string) { if (kind === 'height') state.designHeightMm = value; else if (kind === 'flap') state.designFlapMm = value; else if (kind === 'spine') state.designSpineMm = value; else state.designCoverMm = value; emit(); }, setDesignQr(value: boolean) { state.designQr = value; emit(); }, removeDesignImage() { if (blocked()) return; state.designImage = undefined; state.designImageSha = undefined; emit(); }, setConfirmed(value: boolean) { state.confirmed = value; emit(); }, abandonPending() { if (!alive || state.sending)
            return; state.pending = undefined; state.confirmed = false; state.notice = '已停止本地重试；原操作结果需刷新核对。'; emit(); }, previewFailed() { state.detailPhase = 'error'; state.detailError = '排版预览显示失败，请重新读取本份印刷文件。'; emit(); }, dispose() { alive = false; listToken++; detailToken++; imageToken++; } };
}
