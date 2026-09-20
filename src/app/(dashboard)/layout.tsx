import { AppShell } from "@/components/app-shell";
import { requireSessionUser } from "@/lib/session";
import { getConnectedPlatforms } from "@/app/actions/posts";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireSessionUser();
  const platforms = await getConnectedPlatforms();

  return (
    <AppShell
      user={{
        name: user.name,
        email: user.email,
        username: user.username,
      }}
      connectedPlatforms={platforms as any}
    >
      {children}
    </AppShell>
  );
}
