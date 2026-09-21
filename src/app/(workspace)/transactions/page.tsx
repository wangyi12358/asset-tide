import { Suspense } from "react";
import { TransactionsPage } from "@/components/transactions";
export default function Page() {
  return (
    <Suspense>
      <TransactionsPage />
    </Suspense>
  );
}
