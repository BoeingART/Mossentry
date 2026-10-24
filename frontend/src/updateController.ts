export type DownloadProgress = { received: number; total: number | null };
export type UpdateState = {
  phase: 'hidden' | 'available' | 'downloading' | 'ready' | 'installing' | 'error';
  version?: string;
  progress?: DownloadProgress;
  error?: string;
  retry?: 'download' | 'install';
};
export type UpdateTransport = {
  check: () => Promise<string | null>;
  download: (progress: (value: DownloadProgress) => void) => Promise<void>;
  install: () => Promise<void>;
};

function errorMessage(cause: unknown) {
  if (cause && typeof cause === 'object' && 'detail' in cause) return String(cause.detail);
  return cause instanceof Error ? cause.message : 'Could not update Mossentry. Please retry.';
}

// Shared outside React so StrictMode, language changes and re-renders cannot
// duplicate a download or discard a package that is ready to install.
export class UpdateController {
  private state: UpdateState = { phase: 'hidden' };
  private listeners = new Set<() => void>();
  private pending = false;
  private transport: UpdateTransport;

  constructor(transport: UpdateTransport) { this.transport = transport; }
  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private publish(state: UpdateState) {
    this.state = state;
    this.listeners.forEach(listener => listener());
  }
  async check() {
    if (this.pending || this.state.phase !== 'hidden') return;
    this.pending = true;
    let version: string | null;
    try { version = await this.transport.check(); }
    catch { return; } // No release, offline or unavailable GitHub: keep the button hidden.
    finally { this.pending = false; }
    if (!version) return;
    this.publish({ phase: 'available', version });
  }
  async download() {
    if (this.pending || !(this.state.phase === 'available' || (this.state.phase === 'error' && this.state.retry === 'download'))) return;
    this.pending = true;
    const version = this.state.version;
    this.publish({ phase: 'downloading', version });
    try {
      await this.transport.download(progress => {
        // IPC progress can arrive after the command's final response.
        if (this.state.phase === 'downloading') this.publish({ phase: 'downloading', version, progress });
      });
      this.publish({ phase: 'ready', version });
    } catch (cause) {
      this.publish({ phase: 'error', version, error: errorMessage(cause), retry: 'download' });
    } finally { this.pending = false; }
  }
  async install() {
    if (this.pending || !(this.state.phase === 'ready' || this.state.retry === 'install')) return;
    this.pending = true;
    const version = this.state.version;
    this.publish({ phase: 'installing', version });
    try { await this.transport.install(); }
    catch (cause) {
      this.publish({ phase: 'error', version, error: errorMessage(cause), retry: 'install' });
    } finally { this.pending = false; }
  }
  async poll() {
    if (this.state.phase === 'hidden') await this.check();
  }
}
