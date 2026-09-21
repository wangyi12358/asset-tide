import { SharingPage } from "@/components/sharing";
import { Suspense } from "react";
import { notFound } from "next/navigation";
import { Workspace } from "@/components/workspace";
import { Dashboard } from "@/components/dashboard";
import { AssetsPage } from "@/components/holdings";
import { AssetDetail } from "@/components/asset-detail";
import { TransactionsPage } from "@/components/transactions";
import { SettingsPage } from "@/components/settings";
export default async function Demo({
  params,
}: {
  params: Promise<{ path?: string[] }>;
}) {
  const { path = [] } = await params;
  const content = !path.length ? (
    <Dashboard />
  ) : path[0] === "assets" ? (
    path[1] ? (
      <AssetDetail id={decodeURIComponent(path[1])} />
    ) : (
      <AssetsPage />
    )
  ) : path[0] === "transactions" ? (
    <TransactionsPage />
  ) : path[0] === "shared" ? (
    <SharingPage />
  ) : path[0] === "settings" ? (
    <SettingsPage />
  ) : (
    notFound()
  );
  return (
    <Suspense>
      <Workspace demo>{content}</Workspace>
    </Suspense>
  );
}
