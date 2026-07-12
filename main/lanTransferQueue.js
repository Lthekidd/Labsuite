const { EventEmitter } = require('events');
const path = require('path');
const lanFileServer = require('./lanFileServer');

let nextJobId = 1;

class CancelToken {
  constructor() {
    this.cancelled = false;
    this.handlers = new Set();
  }

  cancel() {
    if (this.cancelled) return;
    this.cancelled = true;
    for (const handler of [...this.handlers]) {
      try {
        handler();
      } catch (_) {}
    }
    this.handlers.clear();
  }

  onCancel(handler) {
    if (this.cancelled) {
      handler();
      return () => {};
    }
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
}

class LanTransferQueue extends EventEmitter {
  constructor() {
    super();
    this.jobs = [];
    this.currentJob = null;
    this.changeTimer = null;
  }

  enqueue(payload) {
    const now = new Date().toISOString();
    const job = {
      id: `lan-${Date.now()}-${nextJobId++}`,
      status: 'queued',
      label: payload.label || this.makeLabel(payload),
      kind: payload.kind,
      direction: payload.direction || this.getDirection(payload.kind),
      payload: { ...payload },
      conflictStrategy: payload.conflictStrategy || 'keepBoth',
      bytesDone: 0,
      bytesTotal: 0,
      fileIndex: null,
      fileCount: null,
      speed: 0,
      etaSeconds: null,
      verified: false,
      skipped: false,
      error: '',
      result: null,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      completedAt: null,
      cancelToken: null
    };
    this.jobs.unshift(job);
    this.emitChange();
    this.processNext();
    return this.toPublicJob(job);
  }

  makeLabel(payload) {
    if (payload.text) {
      const display = payload.text.trim().slice(0, 15);
      return `Pasted text (${display}${payload.text.length > 15 ? '...' : ''})`;
    }
    if (payload.localPath) return path.basename(payload.localPath);
    if (payload.remotePath) return path.basename(String(payload.remotePath).replace(/[\\/]+$/, '')) || payload.remotePath;
    return 'LAN transfer';
  }

  getDirection(kind) {
    if (kind === 'drop-text') return 'upload';
    return String(kind || '').startsWith('download') ? 'download' : 'upload';
  }

  getJobs() {
    return this.jobs.map(job => this.toPublicJob(job));
  }

  clearFinished() {
    this.jobs = this.jobs.filter(job => !['complete', 'failed', 'canceled'].includes(job.status));
    this.emitChange();
    return this.getJobs();
  }

  cancel(jobId) {
    const job = this.jobs.find(item => item.id === jobId);
    if (!job) return { success: false, error: 'Transfer job not found.' };

    if (job.status === 'queued') {
      job.status = 'canceled';
      job.error = 'Canceled before start.';
      job.updatedAt = new Date().toISOString();
      job.completedAt = job.updatedAt;
      this.emitChange();
      return { success: true, job: this.toPublicJob(job) };
    }

    if (job.status === 'running' && job.cancelToken) {
      job.cancelRequested = true;
      job.cancelToken.cancel();
      job.updatedAt = new Date().toISOString();
      this.emitChange();
      return { success: true, job: this.toPublicJob(job) };
    }

    return { success: false, error: 'Only queued or running transfers can be canceled.' };
  }

  retry(jobId) {
    const job = this.jobs.find(item => item.id === jobId);
    if (!job) return { success: false, error: 'Transfer job not found.' };
    if (!['failed', 'canceled'].includes(job.status)) {
      return { success: false, error: 'Only failed or canceled transfers can be retried.' };
    }

    job.status = 'queued';
    job.bytesDone = 0;
    job.bytesTotal = 0;
    job.fileIndex = null;
    job.fileCount = null;
    job.speed = 0;
    job.etaSeconds = null;
    job.verified = false;
    job.skipped = false;
    job.error = '';
    job.result = null;
    job.startedAt = null;
    job.completedAt = null;
    job.cancelRequested = false;
    job.cancelToken = null;
    job.updatedAt = new Date().toISOString();
    this.emitChange();
    this.processNext();
    return { success: true, job: this.toPublicJob(job) };
  }

  async processNext() {
    if (this.currentJob) return;
    const job = [...this.jobs].reverse().find(item => item.status === 'queued');
    if (!job) return;

    this.currentJob = job;
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    job.updatedAt = job.startedAt;
    job.cancelToken = new CancelToken();
    this.emitChange();

    try {
      const result = await this.runJob(job);
      if (job.cancelToken.cancelled) throw this.makeCancelError();
      job.status = 'complete';
      job.result = result;
      job.verified = result && result.verified !== false;
      job.skipped = !!(result && result.skipped);
      job.bytesDone = result && result.bytes ? result.bytes : job.bytesDone;
      job.bytesTotal = job.bytesTotal || job.bytesDone;
      job.completedAt = new Date().toISOString();
      job.updatedAt = job.completedAt;
    } catch (error) {
      const canceled = job.cancelToken && job.cancelToken.cancelled;
      job.status = canceled ? 'canceled' : 'failed';
      job.error = canceled ? 'Canceled.' : (error.message || String(error));
      job.completedAt = new Date().toISOString();
      job.updatedAt = job.completedAt;
    } finally {
      job.cancelToken = null;
      this.currentJob = null;
      this.emitChange();
      setImmediate(() => this.processNext());
    }
  }

  async runJob(job) {
    const payload = job.payload;
    const options = {
      conflictStrategy: job.conflictStrategy,
      cancelToken: job.cancelToken
    };
    const onProgress = progress => this.updateProgress(job, progress);

    switch (job.kind) {
      case 'download-file':
        return lanFileServer.downloadPeerFile(payload.peer, payload.remotePath, payload.destination, onProgress, options);
      case 'download-folder':
        return lanFileServer.downloadPeerFolder(payload.peer, payload.remotePath, payload.destination, onProgress, options);
      case 'upload-file':
        return lanFileServer.uploadFileToPeer(payload.peer, payload.localPath, payload.remoteDestinationDir, onProgress, options);
      case 'upload-folder':
        return lanFileServer.uploadFolderToPeer(payload.peer, payload.localPath, payload.remoteDestinationDir, onProgress, options);
      case 'drop-text': {
        return lanFileServer.sendDropText(payload.peer, payload.text).then(res => {
          const textLength = Buffer.byteLength(payload.text, 'utf8');
          if (typeof onProgress === 'function') {
            onProgress({ bytesDone: textLength, bytesTotal: textLength, fileName: res.fileName || 'text.txt', done: true, verified: true });
          }
          return { success: true, bytes: textLength, verified: true };
        });
      }
      default:
        throw new Error(`Unknown LAN transfer job: ${job.kind}`);
    }
  }

  updateProgress(job, progress = {}) {
    const now = Date.now();
    job.bytesDone = Number(progress.bytesDone) || job.bytesDone || 0;
    job.bytesTotal = Number(progress.bytesTotal) || job.bytesTotal || 0;
    job.fileIndex = progress.fileIndex || job.fileIndex;
    job.fileCount = progress.fileCount || job.fileCount;
    job.activeFileName = progress.fileName || job.activeFileName || '';
    job.verified = progress.verified === true ? true : job.verified;
    job.updatedAt = new Date(now).toISOString();

    if (job.startedAt && job.bytesDone > 0) {
      const elapsedSeconds = Math.max(0.001, (now - new Date(job.startedAt).getTime()) / 1000);
      job.speed = job.bytesDone / elapsedSeconds;
      job.etaSeconds = job.bytesTotal > job.bytesDone
        ? Math.round((job.bytesTotal - job.bytesDone) / Math.max(1, job.speed))
        : 0;
    }

    this.emitChange(false);
  }

  makeCancelError() {
    const error = new Error('Transfer canceled.');
    error.code = 'ERR_TRANSFER_CANCELED';
    return error;
  }

  toPublicJob(job) {
    return {
      id: job.id,
      status: job.status,
      label: job.label,
      kind: job.kind,
      direction: job.direction,
      conflictStrategy: job.conflictStrategy,
      bytesDone: job.bytesDone,
      bytesTotal: job.bytesTotal,
      fileIndex: job.fileIndex,
      fileCount: job.fileCount,
      activeFileName: job.activeFileName || '',
      speed: job.speed,
      etaSeconds: job.etaSeconds,
      verified: !!job.verified,
      skipped: !!job.skipped,
      error: job.error,
      result: job.result,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      startedAt: job.startedAt,
      completedAt: job.completedAt
    };
  }

  emitChange(immediate = true) {
    if (immediate) {
      if (this.changeTimer) clearTimeout(this.changeTimer);
      this.changeTimer = null;
      this.emit('change', this.getJobs());
      return;
    }
    if (this.changeTimer) return;
    this.changeTimer = setTimeout(() => {
      this.changeTimer = null;
      this.emit('change', this.getJobs());
    }, 100);
  }
}

module.exports = new LanTransferQueue();
