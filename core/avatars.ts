import type { Account } from './types.js';
import type { Repository } from './store.js';

const MAX_BYTES = 512 * 1024;
const CACHE_MS = 24 * 60 * 60 * 1000;
function photoUrl(raw: string) {
  const url = new URL(raw);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    !/(^|\.)(googleusercontent\.com|ggpht\.com)$/.test(url.hostname)
  )
    throw new Error('头像地址不是受支持的 Google 图片地址');
  return url.href;
}

export async function downloadAvatar(raw: string): Promise<Buffer> {
  let url = photoUrl(raw);
  const signal = AbortSignal.timeout(8000);
  for (let n = 0; n < 4; n++) {
    // Do not forward OAuth credentials to image servers or follow unchecked redirects.
    const response = await fetch(url, { redirect: 'manual', signal });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      url = photoUrl(new URL(response.headers.get('location') || '', url).href);
      continue;
    }
    if (
      !response.ok ||
      !/^image\/(png|jpeg|webp|gif)(;|$)/i.test(response.headers.get('content-type') || '') ||
      Number(response.headers.get('content-length')) > MAX_BYTES
    ) {
      await response.body?.cancel();
      throw new Error('头像不可用或格式不支持');
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('头像内容为空');
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > MAX_BYTES) throw new Error('头像文件过大');
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    return Buffer.concat(chunks);
  }
  throw new Error('头像重定向过多');
}

export class AvatarCache {
  private pending = new Map<string, Promise<string>>();
  constructor(
    private repo: Repository,
    private profile: (id: string) => Promise<Account>,
    private convert: (data: Buffer) => string,
    private now = () => Date.now(),
  ) {}
  refresh(id: string, force = false): Promise<string> {
    const pending = this.pending.get(id);
    if (pending) return pending;
    const job = this.load(id, force).finally(() => this.pending.delete(id));
    this.pending.set(id, job);
    return job;
  }
  private async load(id: string, force: boolean) {
    let account = this.repo.accounts().find((a) => a.id === id);
    if (!account?.ready) return 'unavailable';
    if (!force && account.avatarCheckedAt && this.now() - account.avatarCheckedAt < CACHE_MS)
      return 'cached';
    try {
      if (!account.photoLink || force || account.avatarCheckedAt) account = await this.profile(id);
      const avatar = account.photoLink
        ? this.convert(await downloadAvatar(account.photoLink))
        : undefined;
      if (this.repo.accounts().some((a) => a.id === id))
        this.repo.saveAccount({ ...account, avatar, avatarCheckedAt: this.now() });
      return avatar ? 'updated' : 'unavailable';
    } catch {
      // Keep a working cached image during transient failures, and avoid retry loops.
      const current = this.repo.accounts().find((a) => a.id === id);
      if (current) this.repo.saveAccount({ ...current, avatarCheckedAt: this.now() });
      return 'unavailable';
    }
  }
}
