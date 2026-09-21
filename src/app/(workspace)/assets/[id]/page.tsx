import { AssetDetail } from "@/components/asset-detail";
export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <AssetDetail id={decodeURIComponent(id)} />;
}
