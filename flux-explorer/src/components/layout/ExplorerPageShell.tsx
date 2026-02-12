import { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface ExplorerPageShellProps {
  title: string;
  description?: string;
  eyebrow?: string;
  chips?: string[];
  rightSlot?: ReactNode;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
}

export function ExplorerPageShell({
  title,
  description,
  eyebrow,
  chips = [],
  rightSlot,
  children,
  className,
  contentClassName,
}: ExplorerPageShellProps) {
  return (
    <section
      className={cn(
        "container relative mx-auto max-w-[1600px] px-4 py-6 sm:px-6 sm:py-8",
        className
      )}
    >
      <div className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
        <div className="absolute left-[-12%] top-[8%] h-[38%] w-[34%] rounded-full bg-[radial-gradient(circle,rgba(56,232,255,0.18),transparent_72%)] blur-3xl" />
        <div className="absolute right-[-10%] top-[2%] h-[42%] w-[36%] rounded-full bg-[radial-gradient(circle,rgba(168,85,247,0.2),transparent_72%)] blur-3xl" />
      </div>

      <div className="relative overflow-hidden rounded-[34px] border border-white/[0.08] bg-[linear-gradient(110deg,rgba(4,15,35,0.82),rgba(8,19,43,0.62)_46%,rgba(34,20,58,0.66)_100%)] px-4 py-5 sm:px-7 sm:py-7">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(80%_120%_at_12%_0%,rgba(56,232,255,0.16),transparent_66%),radial-gradient(90%_110%_at_100%_100%,rgba(168,85,247,0.14),transparent_70%)]" />
        <div className="pointer-events-none absolute inset-0 flux-home-grid-motion opacity-35" />

        <div className="relative flex flex-col gap-4">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-4xl">
              {eyebrow ? (
                <p className="text-[10px] uppercase tracking-[0.24em] text-[var(--flux-text-dim)] sm:text-[11px]">
                  {eyebrow}
                </p>
              ) : null}
              <h1 className="mt-1.5 bg-[linear-gradient(120deg,#f7fdff_10%,#97f6ff_42%,#dbb3ff_82%,#f8fdff_100%)] bg-clip-text text-[2rem] font-black uppercase tracking-[0.08em] text-transparent drop-shadow-[0_0_24px_rgba(56,232,255,0.32)] sm:text-5xl sm:tracking-[0.11em]">
                {title}
              </h1>
              {description ? (
                <p className="mt-2.5 max-w-3xl text-sm text-[var(--flux-text-secondary)] sm:text-base">
                  {description}
                </p>
              ) : null}
            </div>
            {rightSlot ? <div className="shrink-0">{rightSlot}</div> : null}
          </div>

          {chips.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2.5 text-[10px] uppercase tracking-[0.18em] text-[var(--flux-text-muted)] sm:text-[11px]">
              {chips.map((chip) => (
                <span
                  key={chip}
                  className="inline-flex items-center gap-2 rounded-full border border-white/[0.12] bg-[rgba(6,16,35,0.62)] px-2.5 py-1"
                >
                  <span className="h-1.5 w-1.5 rounded-full bg-[var(--flux-cyan)] shadow-[0_0_10px_rgba(56,232,255,0.9)]" />
                  {chip}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      </div>

      <div className={cn("relative mt-6", contentClassName)}>{children}</div>
    </section>
  );
}
