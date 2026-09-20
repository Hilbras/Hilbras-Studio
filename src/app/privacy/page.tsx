import Link from "next/link";
import { Sparkles } from "lucide-react";

export const metadata = {
  title: "Privacy Policy — Hilbras Studio",
  description: "Privacy policy for Hilbras Studio.",
};

export default function PrivacyPolicyPage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border">
        <div className="mx-auto max-w-3xl px-4 py-4 flex items-center gap-2.5">
          <Link href="/" className="flex items-center gap-2.5">
            <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-gradient-to-br from-gold-400 to-gold-600 shadow-md shadow-gold-500/20">
              <Sparkles className="size-4 text-white" />
            </div>
            <span className="font-bold text-sm tracking-tight">Hilbras Studio</span>
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 py-12 prose prose-sm dark:prose-invert">
        <h1>Privacy Policy</h1>
        <p className="text-muted-foreground">Last updated: September 20, 2026</p>

        <p>
          Hilbras Studio (&quot;we&quot;, &quot;us&quot;, or &quot;our&quot;) operates the Hilbras Studio platform
          (the &quot;Service&quot;). This Privacy Policy explains how we collect, use, disclose,
          and safeguard your information when you use our Service.
        </p>

        <h2>1. Information We Collect</h2>

        <h3>Account Information</h3>
        <p>
          When you create an account, we collect your name, email address, and username.
          Passwords are stored as bcrypt hashes and cannot be reversed.
        </p>

        <h3>Platform Connections</h3>
        <p>
          When you connect a social media account (e.g., Instagram, Threads, X, LinkedIn),
          we store an encrypted access token and your platform username. This allows us to
          publish content and fetch engagement data on your behalf. Tokens are encrypted
          using AES-256-GCM and can only be decrypted with the encryption key stored
          on our servers.
        </p>

        <h3>AI Provider Credentials</h3>
        <p>
          If you configure a third-party AI provider (e.g., OpenRouter, OpenAI), we store
          your API key in encrypted form. We never send your API key to our own servers —
          it is forwarded directly to your chosen AI provider and then discarded.
        </p>

        <h3>Content</h3>
        <p>
          Posts you create, schedule, or publish through the Service are stored in our
          database. This includes text, image URLs, scheduling information, and per-platform
          publish results.
        </p>

        <h3>Usage Data</h3>
        <p>
          We may collect anonymized usage data such as page views and feature usage to
          improve the Service. This data cannot be traced back to individual users.
        </p>

        <h2>2. How We Use Your Information</h2>
        <ul>
          <li>To provide, maintain, and improve the Service</li>
          <li>To publish content to your connected social media accounts at your request</li>
          <li>To generate AI-powered content based on your prompts</li>
          <li>To display analytics and engagement metrics for your connected accounts</li>
          <li>To authenticate you and protect against unauthorized access</li>
        </ul>

        <h2>3. How We Share Your Information</h2>
        <p>
          We do not sell your personal information. We share information only in the
          following circumstances:
        </p>
        <ul>
          <li>
            <strong>With social media platforms:</strong> When you publish content, we
            transmit your post to the selected platform using official APIs. This is done
            solely at your direction.
          </li>
          <li>
            <strong>With AI providers:</strong> When you generate content, your prompt and
            platform context are sent to your configured AI provider. No personal data
            beyond what is needed for the request is shared.
          </li>
          <li>
            <strong>With infrastructure providers:</strong> Our Service is hosted on Vercel
            and uses Supabase for database hosting. These providers process data on our
            behalf under strict security obligations.
          </li>
          <li>
            <strong>Legal compliance:</strong> We may disclose information if required by
            law or to protect the rights, property, or safety of Hilbras Studio, our users,
            or the public.
          </li>
        </ul>

        <h2>4. Data Security</h2>
        <p>
          We implement industry-standard security measures including:
        </p>
        <ul>
          <li>AES-256-GCM encryption for all stored tokens and API keys</li>
          <li>bcrypt password hashing with salt</li>
          <li>JWT-based session authentication with httpOnly cookies</li>
          <li>TLS encryption for all data in transit</li>
          <li>Row-level database access — each user can only access their own data</li>
        </ul>
        <p>
          While we strive to protect your information, no method of electronic
          transmission or storage is 100% secure. We cannot guarantee absolute security.
        </p>

        <h2>5. Data Retention</h2>
        <p>
          We retain your data for as long as your account is active. When you delete your
          account, we permanently remove your personal information, connected account
          tokens, and content within 30 days. Some anonymized data may be retained for
          analytics purposes.
        </p>

        <h2>6. Your Rights</h2>
        <p>Depending on your location, you may have the right to:</p>
        <ul>
          <li>Access the personal data we hold about you</li>
          <li>Request correction of inaccurate data</li>
          <li>Request deletion of your personal data</li>
          <li>Export your data in a portable format</li>
          <li>Withdraw consent for data processing at any time</li>
        </ul>
        <p>
          To exercise these rights, contact us at the email address below.
        </p>

        <h2>7. Third-Party Services</h2>
        <p>
          Our Service integrates with the following third-party platforms. Each has its
          own privacy policy:
        </p>
        <ul>
          <li>Meta (Instagram, Facebook, Threads)</li>
          <li>X (formerly Twitter)</li>
          <li>LinkedIn</li>
          <li>TikTok</li>
          <li>YouTube (Google)</li>
          <li>Pinterest</li>
          <li>Reddit</li>
        </ul>
        <p>
          We are not responsible for the privacy practices of these third-party services.
        </p>

        <h2>8. Children&apos;s Privacy</h2>
        <p>
          The Service is not intended for use by individuals under the age of 16. We do
          not knowingly collect personal information from children. If we learn that we
          have collected data from a child, we will delete it promptly.
        </p>

        <h2>9. Changes to This Policy</h2>
        <p>
          We may update this Privacy Policy from time to time. We will notify you of any
          material changes by posting the new policy on this page and updating the
          &quot;Last updated&quot; date.
        </p>

        <h2>10. Contact Us</h2>
        <p>
          If you have any questions about this Privacy Policy, please contact us at:
        </p>
        <p>
          <strong>Email:</strong> privacy@hilbras.com
          <br />
          <strong>Website:</strong>{" "}
          <Link href="/" className="text-gold-600 dark:text-gold-400">
            https://hilbras-studio.vercel.app
          </Link>
        </p>
      </main>
    </div>
  );
}
