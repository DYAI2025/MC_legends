"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { adminGateMessage } from "@/app/admin-gate-message";
import { createBrowserAdminSessionClient } from "@/composition/browser";

const sessionClient = createBrowserAdminSessionClient();

/**
 * The admin sign-in panel that stands in for the inbox until this browser holds an
 * admin session.
 *
 * It knows the code an adult types and nothing else. The session it earns is set by the
 * server as an HttpOnly cookie, so this component cannot read it, cannot store it and
 * has nothing to leak - which is why the page's decision about what to show is made on
 * the server and not here.
 */
export function AdminAccessGate() {
  const router = useRouter();
  const [accessCode, setAccessCode] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [isChecking, setIsChecking] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (accessCode.trim().length === 0 || isChecking) return;

    setIsChecking(true);
    setMessage(null);

    try {
      const attempt = await sessionClient.openSession(accessCode);

      if (attempt === "granted") {
        setAccessCode("");
        // The server decided what this page shows, so only the server can change it.
        router.refresh();
        return;
      }

      setMessage(adminGateMessage(attempt));
    } finally {
      setIsChecking(false);
    }
  }

  return (
    <form className="family-gate" onSubmit={handleSubmit}>
      <p className="family-gate-intro">
        Dieser Bereich ist nur für das Projektteam. Er braucht einen eigenen Zugangscode -
        nicht den Familien-Code.
      </p>
      <label htmlFor="admin-code">Projekt-Zugangscode</label>
      <input
        id="admin-code"
        type="password"
        autoComplete="off"
        value={accessCode}
        onChange={(event) => setAccessCode(event.target.value)}
      />
      <div className="form-footer">
        <button
          className="button button-primary"
          disabled={isChecking || accessCode.trim().length === 0}
          type="submit"
        >
          {isChecking ? "Wird geprüft …" : "Anmelden"}
        </button>
      </div>
      {message === null ? null : (
        <p className="form-message" role="status">
          {message}
        </p>
      )}
    </form>
  );
}
