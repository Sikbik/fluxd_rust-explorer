import { LatestBlocks } from "@/components/home/LatestBlocks";
import { RecentBlockRewards } from "@/components/home/RecentBlockRewards";
import { RealtimeSignalHero } from "@/components/home/RealtimeSignalHero";

export default function Home() {
  return (
    <div className="min-h-screen pb-20">
      <div className="container max-w-[1600px] mx-auto px-4 pt-8 sm:px-6 sm:pt-10">
        <RealtimeSignalHero />
      </div>

      <div className="container max-w-[1600px] mx-auto px-4 pt-10 sm:px-6 sm:pt-12">
        <div className="mb-6 flex items-end justify-between gap-4">
          <div>
            <p className="text-[10px] uppercase tracking-[0.28em] text-[var(--flux-text-dim)]">
              Live Data Feeds
            </p>
            <h2 className="mt-2 text-2xl font-bold text-[var(--flux-text-primary)] sm:text-3xl">
              Chain Pulse
            </h2>
          </div>
          <p className="max-w-xs text-right text-xs text-[var(--flux-text-muted)] sm:text-sm">
            Runtime telemetry updates continuously from the Flux network.
          </p>
        </div>
        <div className="grid gap-6 sm:gap-8 lg:grid-cols-2">
          <LatestBlocks />
          <RecentBlockRewards />
        </div>
      </div>
    </div>
  );
}
