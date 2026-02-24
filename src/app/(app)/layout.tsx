import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  return (
    <div className="min-h-screen bg-warm-white">
      {/* Minimal navigation */}
      <nav className="border-b border-warm-gray-200 bg-white">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-4">
          <Link
            href="/dashboard"
            className="text-lg font-semibold text-warm-gray-900 hover:text-sage-700 transition-colors"
          >
            Bostad AI
          </Link>
          <div className="flex items-center gap-4">
            <Link
              href="/dashboard"
              className="text-sm text-warm-gray-500 hover:text-sage-600 transition-colors"
            >
              Oversikt
            </Link>
            <span className="text-sm text-warm-gray-500">{user.email}</span>
            <form action="/api/auth/signout" method="POST">
              <button
                type="submit"
                className="text-sm text-warm-gray-500 hover:text-warm-gray-700 transition-colors"
              >
                Logga ut
              </button>
            </form>
          </div>
        </div>
      </nav>

      {/* Content */}
      <main className="mx-auto max-w-5xl px-4 py-8">{children}</main>
    </div>
  );
}
