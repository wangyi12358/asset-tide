import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/server/auth";
import { Workspace } from "@/components/workspace";
export const dynamic = "force-dynamic";
export default async function WorkspaceLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const requestHeaders = await headers();
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session)
    redirect(
      `/login?returnTo=${encodeURIComponent(requestHeaders.get("x-atlas-path") || "/dashboard")}`,
    );
  return <Workspace>{children}</Workspace>;
}
