import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useRef } from "react";

import { supabase } from "@/integrations/supabase/client";
import { useRole } from "@/hooks/use-role";
import { syncMyRole } from "@/lib/roles.functions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

const ROLE_LABEL: Record<string, string> = {
  arzt: "Arzt",
  patient: "Patient",
  spectator: "Zuhörer",
};

export const Route = createFileRoute("/_authenticated/dashboard")({
  head: () => ({
    meta: [
      { title: "Übersicht – Konto und Rolle" },
      {
        name: "description",
        content:
          "Persönliche Übersicht mit E-Mail-Adresse und der zugewiesenen Rolle im System.",
      },
      { property: "og:title", content: "Übersicht – Konto und Rolle" },
      {
        property: "og:description",
        content: "Persönliche Übersicht mit E-Mail-Adresse und zugewiesener Rolle.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Dashboard,
});

function Dashboard() {
  const { data, isLoading, refetch } = useRole();
  const sync = useServerFn(syncMyRole);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // Falls die Whitelist erst nach der Registrierung gepflegt wurde,
  // wird die Rolle hier einmalig nachgezogen.
  const syncedRef = useRef(false);
  useEffect(() => {
    if (syncedRef.current) return;
    if (!isLoading && data && data.role === "spectator") {
      syncedRef.current = true;
      void sync().then(() => refetch());
    }
  }, [isLoading, data, sync, refetch]);

  async function handleSignOut() {
    await queryClient.cancelQueries();
    queryClient.clear();
    await supabase.auth.signOut();
    navigate({ to: "/auth", replace: true });
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4 py-16">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Übersicht</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-1">
            <p className="text-sm text-muted-foreground">Angemeldet als</p>
            <p className="font-medium text-foreground">{data?.email ?? "—"}</p>
          </div>
          <div className="space-y-1">
            <p className="text-sm text-muted-foreground">Zugewiesene Rolle</p>
            {isLoading ? (
              <p className="text-sm text-muted-foreground">wird geladen …</p>
            ) : (
              <Badge variant="secondary">
                {data?.role ? (ROLE_LABEL[data.role] ?? data.role) : "keine"}
              </Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            Die Rolle wird anhand der hinterlegten E-Mail-Adresse vergeben und kann
            nicht selbst gewählt werden.
          </p>
          <Button variant="outline" className="w-full" onClick={handleSignOut}>
            Abmelden
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}
