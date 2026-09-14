import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getMyRole } from "@/lib/roles.functions";

export function useRole() {
  const fetchRole = useServerFn(getMyRole);

  return useQuery({
    queryKey: ["my-role"],
    queryFn: () => fetchRole(),
  });
}
