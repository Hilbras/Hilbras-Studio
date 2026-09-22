/**
 * Wraps every /docs route. Next gives templates a unique key per navigation,
 * so this wrapper (and its DOM) is fully recreated each time the segment
 * changes — replaying the `.docs-page-enter` CSS animation when arriving at
 * the docs and when moving between docs pages alike.
 *
 * Deliberately a plain server component: the prerendered HTML contains the
 * article as-is, so the page (and its entrance motion, which is pure CSS)
 * works without any client JavaScript — unlike an `ssr: false` wrapper,
 * which would strip the text out of the static HTML.
 */
export default function Template({ children }: { children: React.ReactNode }) {
  return <div className="docs-page-enter">{children}</div>;
}
