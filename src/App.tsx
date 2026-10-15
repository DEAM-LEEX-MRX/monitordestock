import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import Monitor from "./Monitor";
import { ALLOWED_DOMAIN, DEMO, supabase } from "./data";

function Login() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const clean = email.trim().toLowerCase();
    if (!clean.endsWith("@" + ALLOWED_DOMAIN)) {
      setError(`Usá tu correo @${ALLOWED_DOMAIN}.`);
      return;
    }
    setBusy(true);
    const { error } = await supabase!.auth.signInWithOtp({
      email: clean,
      options: { emailRedirectTo: window.location.origin },
    });
    setBusy(false);
    if (error) setError(error.message);
    else setSent(true);
  };

  return (
    <div className="login">
      <form className="card" onSubmit={submit}>
        <div className="logo">▮▮▮</div>
        <h1>Monitor de stock</h1>
        {sent ? (
          <p>Te enviamos un enlace a <b>{email}</b>. Abrilo desde este mismo navegador para entrar.</p>
        ) : (
          <>
            <p>Ingresá con tu correo de DEAM. Te llega un enlace para entrar, sin contraseña.</p>
            <input type="email" required autoFocus placeholder={`nombre@${ALLOWED_DOMAIN}`}
                   value={email} onChange={(e) => setEmail(e.target.value)} />
            <button className="btn primary" disabled={busy}>{busy ? "Enviando…" : "Enviarme el enlace"}</button>
          </>
        )}
        {error && <p className="warn">{error}</p>}
      </form>
    </div>
  );
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(DEMO);

  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setReady(true); });
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);

  if (DEMO) return <Monitor email={null} onLogout={() => undefined} />;
  if (!ready) return null;
  if (!session) return <Login />;
  return <Monitor email={session.user.email ?? null} onLogout={() => supabase!.auth.signOut()} />;
}
