import {
  createFileRoute,
  Link,
  Outlet,
  redirect,
  useLocation,
  useNavigate,
} from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import { useRole } from "@/hooks/use-role";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async () => {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) throw redirect({ to: "/auth" });
    return { user: data.user };
  },
  component: AuthenticatedLayout,
});

const ROLE_LABEL: Record<string, string> = {
  arzt: "Arzt",
  patient: "Patient",
  spectator: "Zuhörer",
};

function AuthenticatedLayout() {
  const { data: roleData, isLoading: roleLoading } = useRole();
  const role = roleData?.role;
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  async function handleSignOut() {
    await queryClient.cancelQueries();
    queryClient.clear();
    await supabase.auth.signOut();
    navigate({ to: "/auth", replace: true });
  }

  const linkBase = "rounded-md px-3 py-2 text-sm font-medium transition-colors";
  const linkInactive = "text-muted-foreground hover:text-app-text";
  const linkActive = "bg-muted text-app-text";

  return (
    <div className="flex min-h-screen flex-col bg-app-background">
      <header className="border-b border-border bg-app-background px-4 py-3">
        <nav className="mx-auto flex max-w-5xl items-center justify-between gap-4">
          <div className="flex items-center gap-6">
            <span className="text-sm font-semibold text-app-text">
              {roleLoading
                ? "Rolle wird geladen …"
                : role
                  ? (ROLE_LABEL[role] ?? role)
                  : "Zuhörer"}
            </span>
            <div className="flex items-center gap-2">
              <Link
                to="/dashboard"
                className={cn(
                  linkBase,
                  location.pathname === "/dashboard" ? linkActive : linkInactive,
                )}
              >
                Übersicht
              </Link>
              {(role === "arzt" || role === "patient" || role === "spectator") && (
                <Link
                  to="/transcribe"
                  className={cn(
                    linkBase,
                    location.pathname === "/transcribe"
                      ? linkActive
                      : linkInactive,
                  )}
                >
                  Live-Sprache
                </Link>
              )}
              {role === "arzt" && (
                <Link
                  to="/akte"
                  className={cn(
                    linkBase,
                    location.pathname === "/akte" ? linkActive : linkInactive,
                  )}
                >
                  Akte
                </Link>
              )}
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={handleSignOut}>
            Abmelden
          </Button>
        </nav>
      </header>
      <div className="flex-1">
        <Outlet />
      </div>
    </div>
  );
}
