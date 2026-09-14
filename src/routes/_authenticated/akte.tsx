import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { generateAkte } from "@/lib/akte.functions";
import { useRole } from "@/hooks/use-role";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/integrations/supabase/client";
import type { RealtimeChannel } from "@supabase/supabase-js";

const LIVE_CHANNEL = "medifluent-live";

const ROLE_LABEL: Record<string, string> = {
  arzt: "Arzt",
  patient: "Patient",
  spectator: "Zuhörer",
};

type LogEntry = {
  role: "arzt" | "patient" | "spectator";
  text: string;
  source: "original" | "translated";
  created_at: string;
};

type AkteData = {
  anamnese: string;
  befund: string;
  beurteilung: string;
  prozedere: string;
};

export const Route = createFileRoute("/_authenticated/akte")({
  head: () => ({
    meta: [
      { title: "Aktennotiz" },
      {
        name: "description",
        content:
          "Automatisch erzeugte klinische Aktennotiz aus dem Gesprächsverlauf.",
      },
      { property: "og:title", content: "Aktennotiz" },
      {
        property: "og:description",
        content:
          "Automatisch erzeugte klinische Aktennotiz aus dem Gesprächsverlauf.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: AktePage,
});

function AktePage() {
  const { data: roleData, isLoading: roleLoading } = useRole();
  const role = roleData?.role;
  const generate = useServerFn(generateAkte);
  const channelRef = useRef<RealtimeChannel | null>(null);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [akte, setAkte] = useState<AkteData | null>(null);
  const [verlauf, setVerlauf] = useState<LogEntry[] | null>(null);
  const [approved, setApproved] = useState(false);
  const [rawOpen, setRawOpen] = useState(false);

  useEffect(() => {
    const channel = supabase.channel(LIVE_CHANNEL, {
      config: { broadcast: { self: false } },
    });
    channel.subscribe();
    channelRef.current = channel;

    return () => {
      void channel.unsubscribe();
      channelRef.current = null;
    };
  }, []);

  async function handleGenerate() {
    setLoading(true);
    setError(null);
    setAkte(null);
    setVerlauf(null);
    setApproved(false);

    try {
      const result = await generate();
      setAkte(result.akte);
      setVerlauf(result.verlauf as LogEntry[]);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Aktennotiz konnte nicht erstellt werden";
      setError(message);
    } finally {
      setLoading(false);
    }
  }

  function handleApprove() {
    setApproved(true);
    const channel = channelRef.current;
    if (channel && akte) {
      void channel.send({
        type: "broadcast",
        event: "akte-freigegeben",
        payload: {
          anamnese: akte.anamnese,
          befund: akte.befund,
          beurteilung: akte.beurteilung,
          prozedere: akte.prozedere,
        },
      });
    }
    toast.success("Akte freigegeben");
  }

  if (roleLoading) {
    return (
      <main className="flex min-h-full items-center justify-center bg-app-background px-4 py-16">
        <p className="text-muted-foreground">Rolle wird geladen …</p>
      </main>
    );
  }

  if (role !== "arzt") {
    return (
      <main className="flex min-h-full items-center justify-center bg-app-background px-4 py-16">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle className="text-app-text">Akte nicht verfügbar</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-muted-foreground">
              Die Aktennotiz steht nur Ärzten zur Verfügung. Ihre aktuelle Rolle:{" "}
              <span className="font-medium text-foreground">
                {role ? ROLE_LABEL[role] : "unbekannt"}
              </span>
              .
            </p>
            <Button asChild variant="outline" className="w-full">
              <Link to="/dashboard">Zurück zur Übersicht</Link>
            </Button>
          </CardContent>
        </Card>
      </main>
    );
  }

  return (
    <main className="min-h-full bg-app-background px-4 py-8">
      <div className="mx-auto max-w-3xl space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold text-app-text">Aktennotiz</h1>
          <Button onClick={handleGenerate} disabled={loading}>
            {loading ? "Akte wird erstellt …" : "Akte erstellen"}
          </Button>
        </div>

        {error && (
          <div className="rounded-md border border-destructive/20 bg-destructive/10 p-4 text-sm text-destructive">
            {error}
          </div>
        )}

        {akte && (
          <div className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="text-app-text">Klinische Aktennotiz</CardTitle>
              </CardHeader>
              <CardContent className="space-y-6">
                <AkteSection title="Anamnese" text={akte.anamnese} />
                <AkteSection title="Befund" text={akte.befund} />
                <AkteSection title="Beurteilung" text={akte.beurteilung} />
                <AkteSection title="Prozedere" text={akte.prozedere} />
              </CardContent>
            </Card>

            <Button
              variant="outline"
              className="w-full"
              onClick={handleApprove}
              disabled={approved}
            >
              {approved ? "Akte freigegeben" : "Freigeben"}
            </Button>

            <div className="space-y-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setRawOpen((open) => !open)}
                className="text-muted-foreground"
              >
                {rawOpen ? "Rohverlauf ausblenden" : "Rohverlauf anzeigen"}
              </Button>

              {rawOpen && verlauf && (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-app-text text-base">Chronologischer Rohverlauf</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {verlauf.map((entry, index) => (
                      <div
                        key={index}
                        className="border-l-2 border-border pl-3 text-sm text-app-text"
                      >
                        <div className="flex items-center gap-2">
                          <span className="font-medium">
                            {entry.role === "patient" ? "Patient" : entry.role === "arzt" ? "Arzt" : "Unbekannt"}
                          </span>
                          <Badge variant="outline" className="text-[11px]">
                            {entry.source === "original" ? "Original" : "Übersetzt"}
                          </Badge>
                        </div>
                        <p className="mt-1 whitespace-pre-wrap">{entry.text}</p>
                      </div>
                    ))}
                  </CardContent>
                </Card>
              )}
            </div>
          </div>
        )}
      </div>
    </main>
  );
}

function AkteSection({ title, text }: { title: string; text: string }) {
  return (
    <div className="space-y-2">
      <h2 className="text-lg font-semibold text-app-text">{title}</h2>
      <p className="leading-relaxed text-app-text">{text}</p>
    </div>
  );
}
