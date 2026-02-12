/**
 * Rich List Page
 *
 * Displays the Flux blockchain rich list with pagination
 */

import { Metadata } from "next";
import { RichListTable } from "@/components/rich-list/RichListTable";
import { ExplorerPageShell } from "@/components/layout/ExplorerPageShell";

export const metadata: Metadata = {
  title: "Rich List | Flux Explorer",
  description:
    "View the richest Flux addresses sorted by balance. Complete rich list with rankings and balance percentages.",
};

export default function RichListPage() {
  return (
    <ExplorerPageShell
      eyebrow="Capital Topology"
      title="Flux Rich List"
      description="Inspect ranked balances, supply share, and distribution behavior across the Flux address universe."
      chips={["Top holders", "Supply distribution", "Address intelligence"]}
    >
      <RichListTable />
    </ExplorerPageShell>
  );
}
