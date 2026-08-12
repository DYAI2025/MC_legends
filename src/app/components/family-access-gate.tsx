"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { familyGateMessage } from "@/app/family-gate-message";
import { createBrowserFamilySessionClient } from "@/composition/browser";

const sessionClient = createBrowserFamilySessionClient();

/**
 * The sign-in panel that stands in for the answer form until this browser holds a
 * family session.
 *
 * It knows the code the family types and nothing else. The session it earns is set by
 * the server as an HttpOnly cookie, so this component cannot read it, cannot store it
 * and has nothing to leak - which is why the page's decision about what to show is
 * made on the server and not here.
 */
export function FamilyAccessGate() {
  const router = useRouter();
  const [accessCode, setAccessCode] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [isChecking, setIsChecking] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (accessCode.trim().length === 0 || isChecking) return;

    setIsChecking(true);
    // Drop the previous sentence first, so an old one cannot sit under the button
    // while the new attempt is still running.
    setMessage(null);

    try {
      const attempt = await sessionClient.openSession(accessCode);

      if (attempt === "granted") {
        setAccessCode("");
        // The server decided what this page shows, so only the server can change it.
        router.refresh();
        return;
      }

      setMessage(familyGateMessage(attempt));
    } finally {
      setIsChecking(false);
    }
  }

  return (
    <form className="family-gate" onSubmit={handleSubmit}>
      <p className="family-gate-intro">
        Zum Antworten braucht ihr einmal euren Familien-Code.
      </p>
      <label htmlFor="family-code">Familien-Code</label>
      <input
        id="family-code"
        // type="password" so the code is not readable over a child's shoulder, and
        // autoComplete off so a shared family device does not offer it to a guest.
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
          {isChecking ? "Wird geprüft …" : "Weiter"} <span aria-hidden="true">→</span>
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
