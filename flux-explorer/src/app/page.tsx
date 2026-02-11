import { RealtimeSignalHero } from "@/components/home/RealtimeSignalHero";

export default function Home() {
  return (
    <div className="relative min-h-screen overflow-hidden pb-24 pt-2 sm:pt-4">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute inset-0 bg-[radial-gradient(1200px_520px_at_50%_-120px,rgba(56,232,255,0.2),transparent_62%)]" />
        <div className="absolute -left-[18%] top-[25%] h-[640px] w-[640px] rounded-full bg-[radial-gradient(circle,rgba(67,143,255,0.2)_0%,transparent_68%)] blur-[90px]" />
        <div className="absolute -right-[17%] top-[18%] h-[700px] w-[700px] rounded-full bg-[radial-gradient(circle,rgba(176,110,255,0.22)_0%,transparent_65%)] blur-[90px]" />
      </div>

      <div className="relative w-full px-2 sm:px-4 lg:px-6">
        <RealtimeSignalHero />
      </div>
    </div>
  );
}
