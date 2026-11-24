import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import {flushSync} from 'react-dom';
import { UserClient, ApiFailure } from '../api/client';
import { authorityKey, type UserSession } from '../api/contracts';
const Portal = lazy(() => import('./Portal'));
const api = new UserClient();
export function App() {
  const [session, setSession] = useState<UserSession | null>(null);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState<unknown>();
  const [offline,setOffline]=useState(()=>!navigator.onLine);
  const [connectionEpoch,setConnectionEpoch]=useState(0);
  const request = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const signedOut = useRef(false);
  const logoutIntent = useRef<UserSession | null>(null);
  const retire=useCallback(()=>{
    generation.current++;
    request.current?.abort();
    setSession(null);
    setConnectionEpoch(value=>value+1);
  },[]);
  const refresh = useCallback(async (forceGate = false) => {
    if(!navigator.onLine){retire();setOffline(true);setChecking(false);return;}
    setOffline(false);
    if (signedOut.current && !forceGate) return;
    if (forceGate) { signedOut.current = false; setSession(null); setChecking(true); }
    const current = ++generation.current; request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    try {
      const value = await api.session(controller.signal);
      if (current === generation.current) { setSession(value); setError(undefined); logoutIntent.current = null; }
    } catch (failure) {
      if (!controller.signal.aborted && current === generation.current) { setSession(null); setError(failure); }
    } finally { if (current === generation.current) setChecking(false); }
  }, [retire]);
  useEffect(() => {
    const focus=()=>{void refresh();};
    const lost=()=>{retire();setOffline(true);setChecking(false);};
    const reconnect=()=>{
      setOffline(!navigator.onLine);
      if(signedOut.current)return;
      retire();
      setChecking(true);
      void refresh();
    };
    const hide=(event:PageTransitionEvent)=>{
      // A persisted page can be frozen immediately after this event.
      if(event.persisted)flushSync(()=>{retire();setChecking(!signedOut.current);});
    };
    const show=(event:PageTransitionEvent)=>{if(event.persisted)reconnect();};
    void refresh();
    window.addEventListener('focus',focus);
    window.addEventListener('offline',lost);
    window.addEventListener('online',reconnect);
    window.addEventListener('pagehide',hide);
    window.addEventListener('pageshow',show);
    return ()=>{
      generation.current++;request.current?.abort();
      window.removeEventListener('focus',focus);
      window.removeEventListener('offline',lost);
      window.removeEventListener('online',reconnect);
      window.removeEventListener('pagehide',hide);
      window.removeEventListener('pageshow',show);
    };
  }, [refresh,retire]);
  useEffect(() => {
    if (!session) return;
    const timer = setTimeout(() => { void refresh(); }, Math.max(1, Math.min(60000, Date.parse(session.expires_at) - Date.now())));
    return () => clearTimeout(timer);
  }, [session, refresh]);
  const logout = async () => {
    const current = session ?? logoutIntent.current;
    logoutIntent.current = current; signedOut.current = true; generation.current++; request.current?.abort();
    setSession(null); setChecking(true);
    try { if (current) await api.logout(current); else await api.logoutCurrent(); logoutIntent.current = null; setError(new ApiFailure(401, 'SIGNED_OUT')); }
    catch (failure) { setError(failure); }
    finally { setChecking(false); }
  };
  if (session && !offline) return <Suspense fallback={<div className="loading-page"><span className="spinner" />正在打开用户空间</div>}>
    <Portal key={JSON.stringify([authorityKey(session),connectionEpoch])} session={session} invalidate={() => { if (!signedOut.current) void refresh(true); }} logout={() => { void logout(); }} />
  </Suspense>;
  const unavailable = Boolean(error) && !(error instanceof ApiFailure && error.status === 401);
  return <main className="welcome"><header className="brand"><span className="brand-mark">o</span>orange<span className="brand-label">用户空间</span></header>
    <section className="welcome-grid"><div className="welcome-copy"><p className="eyebrow">YOUR WORKSPACE</p><h1>从你的空间开始。</h1><p className="lead">管理组织与成员身份，为团队建立清晰的协作边界。</p>
      <div className="principles"><p><span>01</span>个人与团队空间分别归属</p><p><span>02</span>内容共享需要明确授权</p><p><span>03</span>费用与操作结果按记录核对</p></div></div>
      <div className="login-card">{offline ? <><h2>网络已断开</h2><p>{signedOut.current?'恢复连接后可核对退出状态。':'恢复连接后将重新核对用户身份。'}</p></> : checking ? <div className="login-loading"><span className="spinner" /><h2>正在确认登录状态</h2></div>
        : <><p className="eyebrow">ORANGE ACCOUNT</p><h2>{logoutIntent.current ? '退出尚未确认' : unavailable ? '暂时无法连接用户空间' : '登录你的账户'}</h2>
          <p>通过身份服务登录后，进入你的个人空间。组织权限由当前成员身份决定。</p>
          {unavailable && <div role="alert" className="gate-alert">请求尚未完成，请稍后重试。</div>}
          {error instanceof ApiFailure && error.code === 'SIGNED_OUT' && <p role="status">已退出当前会话。</p>}
          {logoutIntent.current ? <button className="primary-button" onClick={() => { void logout(); }}>重试退出</button> : <a className="primary-button" href="/api/v1/auth/start">登录用户空间</a>}
          <button className="text-button" onClick={() => { void refresh(true); }}>重新检查会话</button>
          {!(error instanceof ApiFailure && error.code === 'SIGNED_OUT') && <button className="text-button" onClick={() => { void logout(); }}>退出当前会话</button>}
          <p className="login-note">平台管理使用独立入口和管理身份验证。</p></>}
      </div></section><footer className="welcome-footer">Orange Agent · 用户访问与组织管理</footer>
  </main>;
}
