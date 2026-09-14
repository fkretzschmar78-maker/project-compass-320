import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Startseite – Zugang mit Rollen" },
      {
        name: "description",
        content:
          "Zugang für Ärzte, Patienten und stille Zuhörer. Die Rolle wird beim Anmelden automatisch anhand der E-Mail-Adresse vergeben.",
      },
      { property: "og:title", content: "Startseite – Zugang mit Rollen" },
      {
        property: "og:description",
        content:
          "Zugang für Ärzte, Patienten und stille Zuhörer mit automatischer Rollenvergabe.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

function Index() {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);

  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => setSignedIn(!!data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setSignedIn(!!session);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-xl space-y-6 text-center">
        <h1 className="text-4xl font-semibold tracking-tight text-foreground">
          Zugang mit fester Rollenzuordnung
        </h1>
        <p className="text-muted-foreground">
          Ärzte, Patienten und stille Zuhörer melden sich mit ihrer E-Mail-Adresse an.
          Die Rolle wird automatisch vergeben und lässt sich nicht selbst wählen.
        </p>
        <div className="flex justify-center">
          {signedIn ? (
            <Button asChild>
              <Link to="/dashboard">Zur Übersicht</Link>
            </Button>
          ) : (
            <Button asChild>
              <Link to="/auth">Anmelden</Link>
            </Button>
          )}
        </div>
      </div>
    </main>
  );
}
