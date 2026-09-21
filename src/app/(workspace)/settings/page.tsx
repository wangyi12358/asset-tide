import { Suspense } from "react";
import { SettingsPage } from "@/components/settings";
export default function Page() {
  return (
    <Suspense>
      <SettingsPage />
    </Suspense>
  );
}
