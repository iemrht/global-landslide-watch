import { FormEvent, ReactNode, useEffect, useState } from 'react';
import { LockKeyhole, Mountain, ShieldCheck } from 'lucide-react';

const SESSION_KEY = 'global_landslide_pages_session';
const SESSION_MS = 12 * 60 * 60 * 1000;
// 用 `pnpm set-password` 修改；这里只保存 SHA-256 摘要，不保存明文。
const PASSWORD_SHA256 = '08e2c8d8fa32bb870b29fba8fff2736a555376d88d1df063580195157e446fff';
const IS_GITHUB_PAGES = import.meta.env.MODE === 'github-pages';

function validSession() {
  if (!IS_GITHUB_PAGES || new URLSearchParams(window.location.search).get('logout') === '1') return false;
  try {
    return Number(window.localStorage.getItem(SESSION_KEY)) > Date.now();
  } catch {
    return false;
  }
}

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await window.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export default function StaticAccessGate({ children }: { children: ReactNode }) {
  const [authorized, setAuthorized] = useState(validSession);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    if (!IS_GITHUB_PAGES || new URLSearchParams(window.location.search).get('logout') !== '1') return;
    window.localStorage.removeItem(SESSION_KEY);
    window.history.replaceState({}, '', import.meta.env.BASE_URL);
    setAuthorized(false);
  }, []);

  if (!IS_GITHUB_PAGES || authorized) return children;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setChecking(true);
    setError('');
    try {
      if (await sha256(password) !== PASSWORD_SHA256) {
        setError('密码不正确，请重新输入。');
        setPassword('');
        return;
      }
      window.localStorage.setItem(SESSION_KEY, String(Date.now() + SESSION_MS));
      setAuthorized(true);
    } finally {
      setChecking(false);
    }
  }

  return (
    <main className="static-access-page">
      <section className="static-access-card" aria-labelledby="static-access-title">
        <div className="static-access-brand">
          <span><Mountain aria-hidden="true" /></span>
          <div><strong>全球震后滑坡概率图</strong><small>GLOBAL LANDSLIDE WATCH</small></div>
        </div>
        <div className="static-access-channel"><ShieldCheck aria-hidden="true" />GitHub Pages 访问通道</div>
        <h1 id="static-access-title">进入滑坡监测台</h1>
        <p>全球 M≥6.0 地震与 USGS 官方震后滑坡概率。</p>
        <form onSubmit={submit}>
          <label htmlFor="static-password">访问密码</label>
          <div className="static-password-field"><LockKeyhole aria-hidden="true" /><input id="static-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" autoFocus required placeholder="请输入访问密码" /></div>
          {error && <p className="static-access-error" role="alert">{error}</p>}
          <button type="submit" disabled={checking}>{checking ? '正在验证…' : '验证并进入'}</button>
        </form>
        <p className="static-access-note">本站采用浏览器端访问口令，并在本设备保留 12 小时会话；用于一般访问控制，不等同于服务器端保密。</p>
      </section>
    </main>
  );
}
