import { Logo } from '@/components/brand/logo';

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative flex min-h-dvh flex-col items-center justify-center px-4 py-10">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 bg-[linear-gradient(to_right,var(--border)_1px,transparent_1px),linear-gradient(to_bottom,var(--border)_1px,transparent_1px)] bg-[size:48px_48px] opacity-40 [mask-image:radial-gradient(ellipse_at_center,black_30%,transparent_75%)]"
      />
      <main className="w-full max-w-sm">
        <div className="mb-8 flex justify-center">
          <Logo markClassName="size-9" />
        </div>
        {children}
        <p className="mt-6 text-center text-xs text-fg-subtle">Self-hosted · End-to-end under your control</p>
      </main>
    </div>
  );
}
