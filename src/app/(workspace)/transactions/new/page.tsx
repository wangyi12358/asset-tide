import { Suspense } from "react";
import { EntryForm } from "@/components/entry-form";
export default function Page() {
  return (
    <Suspense>
      <EntryForm />
    </Suspense>
  );
}
