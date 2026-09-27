import { AppShell } from "@/components/app-shell";
import { PLATFORMS, type Platform } from "@/components/platform-icon";
import { requireSessionUser } from "@/lib/session";
import { getConnectedPlatforms } from "@/app/actions/posts";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireSessionUser();
  const platforms = await getConnectedPlatforms();
  const connectedPlatforms = platforms.filter((platform): platform is Platform =>
    PLATFORMS.includes(platform as Platform),
  );

  return (
    <AppShell
      user={{
        name: user.name,
        email: user.email,
        username: user.username,
      }}
      connectedPlatforms={connectedPlatforms}
    >
      {children}
    </AppShell>
  );
}
