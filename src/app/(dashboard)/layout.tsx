import { AppShell } from "@/components/app-shell";
import { requireSessionUser } from "@/lib/session";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireSessionUser();

  return (
    <AppShell
      user={{
        name: user.name,
        email: user.email,
        username: user.username,
      }}
    >
      {children}
    </AppShell>
  );
}