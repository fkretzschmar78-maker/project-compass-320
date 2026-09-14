import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export const Route = createFileRoute("/auth")({
  head: () => ({
    meta: [
      { title: "Anmelden – Zugang mit E-Mail-Adresse" },
      {
        name: "description",
        content:
          "Anmeldung und Registrierung per E-Mail-Adresse. Die Rolle wird automatisch anhand der hinterlegten Adresse vergeben.",
      },
      { property: "og:title", content: "Anmelden – Zugang mit E-Mail-Adresse" },
      {
        property: "og:description",
        content: "Anmeldung und Registrierung per E-Mail-Adresse.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: AuthPage,
});

function AuthPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => {
      if (data.session) navigate({ to: "/dashboard", replace: true });
    });
  }, [navigate]);

  async function handleSignIn(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    navigate({ to: "/dashboard", replace: true });
  }

  async function handleSignUp(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: window.location.origin },
    });
    setBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    if (data.session) {
      navigate({ to: "/dashboard", replace: true });
      return;
    }
    toast.success("Bitte bestätige die E-Mail, die wir dir geschickt haben.");
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4 py-16">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Zugang</CardTitle>
          <CardDescription>
            Die Rolle wird automatisch anhand deiner E-Mail-Adresse vergeben.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="signin">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="signin">Anmelden</TabsTrigger>
              <TabsTrigger value="signup">Registrieren</TabsTrigger>
            </TabsList>

            <TabsContent value="signin">
              <form className="space-y-4 pt-4" onSubmit={handleSignIn}>
                <Fields
                  email={email}
                  password={password}
                  onEmail={setEmail}
                  onPassword={setPassword}
                  idPrefix="in"
                />
                <Button type="submit" className="w-full" disabled={busy}>
                  Anmelden
                </Button>
              </form>
            </TabsContent>

            <TabsContent value="signup">
              <form className="space-y-4 pt-4" onSubmit={handleSignUp}>
                <Fields
                  email={email}
                  password={password}
                  onEmail={setEmail}
                  onPassword={setPassword}
                  idPrefix="up"
                />
                <Button type="submit" className="w-full" disabled={busy}>
                  Registrieren
                </Button>
              </form>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </main>
  );
}

function Fields({
  email,
  password,
  onEmail,
  onPassword,
  idPrefix,
}: {
  email: string;
  password: string;
  onEmail: (value: string) => void;
  onPassword: (value: string) => void;
  idPrefix: string;
}) {
  return (
    <>
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-email`}>E-Mail</Label>
        <Input
          id={`${idPrefix}-email`}
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => onEmail(e.target.value)}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-password`}>Passwort</Label>
        <Input
          id={`${idPrefix}-password`}
          type="password"
          autoComplete="current-password"
          required
          minLength={6}
          value={password}
          onChange={(e) => onPassword(e.target.value)}
        />
      </div>
    </>
  );
}
