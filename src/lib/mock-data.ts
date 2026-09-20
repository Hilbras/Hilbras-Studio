import type { Platform } from "@/components/platform-icon";

export interface ConnectedAccount {
  platform: Platform;
  name: string;
  handle: string;
  followers: number;
  connected: boolean;
  lastSync: string;
}

export interface Activity {
  id: string;
  platform: Platform;
  action: string;
  detail: string;
  timestamp: string;
}

export interface StatCard {
  label: string;
  value: string;
  change: string;
  positive: boolean;
}

export const ACCOUNTS: ConnectedAccount[] = [
  { platform: "instagram", name: "Hilbras", handle: "@hilbras", followers: 12400, connected: true, lastSync: "2 min ago" },
  { platform: "x", name: "Hilbras", handle: "@hilbras_ai", followers: 8320, connected: true, lastSync: "5 min ago" },
  { platform: "linkedin", name: "Hilbras Inc.", handle: "hilbras-inc", followers: 4180, connected: true, lastSync: "12 min ago" },
  { platform: "facebook", name: "Hilbras Official", handle: "hilbrasofficial", followers: 6750, connected: true, lastSync: "8 min ago" },
  { platform: "youtube", name: "Hilbras", handle: "@hilbras", followers: 3200, connected: false, lastSync: "—" },
  { platform: "tiktok", name: "Hilbras", handle: "@hilbras", followers: 5400, connected: false, lastSync: "—" },
  { platform: "threads", name: "Hilbras", handle: "@hilbras", followers: 2100, connected: false, lastSync: "—" },
  { platform: "pinterest", name: "Hilbras", handle: "hilbras", followers: 980, connected: false, lastSync: "—" },
  { platform: "reddit", name: "u/hilbras", handle: "u/hilbras", followers: 640, connected: false, lastSync: "—" },
];

export const STATS: StatCard[] = [
  { label: "Total Reach", value: "34.8K", change: "+12.4%", positive: true },
  { label: "Engagement", value: "2,847", change: "+8.1%", positive: true },
  { label: "Posts Published", value: "42", change: "+6", positive: true },
  { label: "AI Suggestions", value: "18", change: "+3", positive: true },
];

export const RECENT_ACTIVITY: Activity[] = [
  { id: "1", platform: "instagram", action: "Post published", detail: "Product launch carousel — 3 slides, CTA link in bio", timestamp: "18 min ago" },
  { id: "2", platform: "x", action: "Thread posted", detail: "5-tweet thread announcing new feature release", timestamp: "32 min ago" },
  { id: "3", platform: "linkedin", action: "Article shared", detail: "Engineering blog post: 'Building AI-Native Social Tools'", timestamp: "1 hr ago" },
  { id: "4", platform: "facebook", action: "Page post", detail: "Shared Instagram carousel natively to Facebook Page", timestamp: "1 hr ago" },
  { id: "5", platform: "x", action: "Engagement spike", detail: "@techcrunch retweeted — 2.1K impressions in 20 min", timestamp: "2 hr ago" },
];

export const WEEKLY_CHART = [
  { day: "Mon", reach: 4200, engagement: 340, posts: 6 },
  { day: "Tue", reach: 3800, engagement: 290, posts: 5 },
  { day: "Wed", reach: 5100, engagement: 420, posts: 7 },
  { day: "Thu", reach: 4600, engagement: 380, posts: 6 },
  { day: "Fri", reach: 6200, engagement: 510, posts: 8 },
  { day: "Sat", reach: 5800, engagement: 480, posts: 5 },
  { day: "Sun", reach: 5100, engagement: 427, posts: 5 },
];