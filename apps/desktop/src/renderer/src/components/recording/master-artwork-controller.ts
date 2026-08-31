import { isMasterArtworkResult, isMasterArtworkVersion, isPickMasterArtworkResult, recordingArtworkImageBytes, type CollectionPhotoImage, type MasterArtworkVersion, type MasterVersion, type RecordingPrintsPublicApi, type SaveMasterArtworkRequest } from '@music-bridge/contracts';
export async function artworkImageSha256(image: CollectionPhotoImage): Promise<string> { const bytes = Uint8Array.from(atob(image.dataUrl.slice(23)), c => c.charCodeAt(0)); return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join(''); }
export interface MasterArtworkState {
    phase: 'unread' | 'loading' | 'ready' | 'error';
    current: MasterArtworkVersion | null;
    image?: CollectionPhotoImage;
    staged?: CollectionPhotoImage;
    confirmed: boolean;
    picking: boolean;
    saving: boolean;
    pending?: SaveMasterArtworkRequest;
    error: string;
    notice: string;
    imageFailed: boolean;
}
export function createMasterArtworkController(options: {
    api: RecordingPrintsPublicApi;
    master: MasterVersion;
    onChange?: () => void;
}) {
    const { api, master } = options;
    const state: MasterArtworkState = { phase: 'unread', current: null, confirmed: false, picking: false, saving: false, error: '', notice: '', imageFailed: false };
    let alive = true, read = 0;
    const emit = () => { if (alive)
        options.onChange?.(); }, blocked = () => state.saving || state.picking || !!state.pending;
    async function refresh() { if (!alive || blocked())
        return; const token = ++read; state.phase = 'loading'; state.image = undefined; state.error = ''; state.imageFailed = false; emit(); try {
        const value = await api.getMasterArtwork({ masterVersionId: master.id });
        if (!alive || token !== read)
            return;
        if (!isMasterArtworkResult(value) || value.masterVersionId !== master.id || value.currentVersion?.id !== value.version?.id)
            throw new Error('IDENTITY');
        if (value.version && value.image && await artworkImageSha256(value.image) !== value.version.sha256)
            throw new Error('HASH');
        if (!alive || token !== read)
            return;
        state.current = value.currentVersion;
        state.image = value.image ?? undefined;
        state.phase = 'ready';
    }
    catch {
        if (alive && token === read) {
            state.phase = 'error';
            state.error = 'Artwork 读取失败；没有用照片或其它封面替代，请明确重试。';
        }
    } emit(); }
    async function pick() { if (!alive || blocked() || state.phase === 'loading')
        return; const token = ++read; state.picking = true; state.confirmed = false; state.error = ''; emit(); try {
        const value = await api.pickMasterArtwork({ masterVersionId: master.id });
        if (!alive || token !== read)
            return;
        if (!isPickMasterArtworkResult(value) || value.state === 'selected' && value.masterVersionId !== master.id)
            throw new Error('IDENTITY');
        if (value.state === 'selected') {
            state.staged = structuredClone(value.image);
            state.imageFailed = false;
            state.notice = '新 Artwork 尚未保存。';
        }
        else
            state.notice = '已取消选图；已有图片保持不变。';
    }
    catch {
        if (alive && token === read)
            state.error = '选图未完成；没有保存任何新 Artwork，请重新选择。';
    }
    finally {
        if (alive && token === read) {
            state.picking = false;
            emit();
        }
    } }
    async function send() { const pending = state.pending; if (!alive || !pending || state.saving)
        return; state.saving = true; state.error = ''; emit(); try {
        const result = await api.saveMasterArtwork(structuredClone(pending));
        if (!alive)
            return;
        const digest = await artworkImageSha256(pending.image);
        if (!alive)
            return;
        if (!isMasterArtworkVersion(result) || result.masterVersionId !== master.id || result.sequence !== (state.current?.sequence ?? 0) + 1 || result.sha256 !== digest || result.width !== pending.image.width || result.height !== pending.image.height || result.size !== recordingArtworkImageBytes(pending.image))
            throw new Error('INVALID_RECEIPT');
        state.current = result;
        state.image = structuredClone(pending.image);
        state.staged = undefined;
        state.pending = undefined;
        state.confirmed = false;
        state.phase = 'ready';
        state.notice = '新的 Artwork 版本已保存；不改变旧录音或印刷文件。';
    }
    catch {
        if (alive)
            state.error = '保存回执尚未确认；请重试原操作，或停止本地重试后重新读取核对。';
    }
    finally {
        if (alive) {
            state.saving = false;
            emit();
        }
    } }
    async function save() { if (!alive || blocked() || state.phase !== 'ready' || !state.staged || !state.confirmed || state.imageFailed)
        return; read++; state.pending = { commandId: crypto.randomUUID(), masterVersionId: master.id, expectedVersionId: state.current?.id ?? null, image: structuredClone(state.staged), userConfirmed: true }; await send(); }
    function abandonPending() { if (!alive || state.saving)
        return; state.pending = undefined; state.staged = undefined; state.confirmed = false; state.phase = 'unread'; state.notice = '已停止本地重试；原保存结果仍需重新读取核对。'; emit(); }
    return { state, refresh, pick, save, retryPending: send, abandonPending, canClose: () => !blocked(), setConfirmed(value: boolean) { state.confirmed = value; emit(); }, discard() { if (blocked())
            return; state.staged = undefined; state.confirmed = false; state.notice = '已放弃未保存图片。'; emit(); }, imageFailed() { state.imageFailed = true; state.error = '此图显示失败；请重新读取或重新选择，不使用替代图。'; emit(); }, dispose() { alive = false; read++; } };
}
