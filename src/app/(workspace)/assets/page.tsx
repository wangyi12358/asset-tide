import { Suspense } from "react";
import { AssetsPage } from "@/components/holdings";
export default function Page() {
  return (
    <Suspense>
      <AssetsPage />
    </Suspense>
  );
}
