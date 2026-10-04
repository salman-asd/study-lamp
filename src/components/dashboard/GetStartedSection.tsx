import Link from "next/link";
import { Button } from "@/components/ui/button";

export function GetStartedSection() {
  return (
    <section className="rounded-2xl border-dashed border-accent/50 bg-accent/5 p-6" data-tour="dash-getstarted">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <p className="text-sm font-medium text-accent">Welcome to Study Lamp</p>
          <h2 className="font-display text-xl font-semibold">Three steps and this dashboard fills itself in.</h2>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Pick what you want to learn, generate a roadmap, then set a goal with a deadline. Everything here —
            pace, recommendations, charts — is built from those.
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button asChild><Link href="/onboarding">Choose interests</Link></Button>
          <Button asChild variant="outline"><Link href="/playlists/import">Add videos</Link></Button>
        </div>
      </div>

      <ol className="mt-5 grid gap-3 sm:grid-cols-3">
        {[
          { n: 1, title: "Pick your interests", detail: "Choose the topics you actually want to learn.", href: "/onboarding", cta: "Set interests" },
          { n: 2, title: "Generate a roadmap", detail: "Get an ordered path of steps for a topic.", href: "/roadmap", cta: "Open roadmap" },
          { n: 3, title: "Set a goal", detail: "Give a step a deadline so pace tracking kicks in.", href: "/goals", cta: "Open goals" },
        ].map((item) => (
          <li key={item.n} className="rounded-lg border-border bg-background/60 p-3">
            <span className="mb-2 inline-flex h-6 w-6 items-center justify-center rounded-full bg-accent/15 text-xs font-semibold text-accent">
              {item.n}
            </span>
            <p className="text-sm font-medium">{item.title}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{item.detail}</p>
            <Button asChild size="sm" variant="link" className="mt-1 h-auto p-0 text-xs">
              <Link href={item.href}>{item.cta} →</Link>
            </Button>
          </li>
        ))}
      </ol>
    </section>
  );
}
