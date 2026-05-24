import Link from "next/link";
import { Plus, Search, Settings as SettingsIcon } from "lucide-react";
import { listTopics } from "@/lib/db";
import { SidebarTopicLink } from "./SidebarTopicLink";

/**
 * Persistent left rail shown at ≥1024px. Holds the topic list, primary nav
 * (search / settings), and the "+ 新規" CTA. On smaller widths the rail is
 * hidden via CSS and the existing top app-header takes over.
 */
export function Sidebar() {
  const topics = listTopics();
  return (
    <aside className="sidebar" aria-label="サイドバー">
      <div className="sidebar__head">
        <Link href="/" className="sidebar__brand">
          Praxill
        </Link>
        <Link
          href="/topics/new"
          className="sidebar__new"
          aria-label="新しい題材"
        >
          <Plus size={16} strokeWidth={2.4} />
          新規
        </Link>
      </div>

      <nav className="sidebar__topics" aria-label="題材一覧">
        {topics.length === 0 ? (
          <div className="sidebar__empty">まだ題材がありません</div>
        ) : (
          topics.map((t) => {
            const draft = t.status === "draft";
            const href = draft ? `/topics/${t.id}/preview` : `/topics/${t.id}`;
            return (
              <SidebarTopicLink
                key={t.id}
                href={href}
                topicId={t.id}
                title={t.title}
                draft={draft}
              />
            );
          })
        )}
      </nav>

      <div className="sidebar__foot">
        <Link href="/search" className="sidebar__nav">
          <Search size={16} strokeWidth={2} />
          検索
        </Link>
        <Link href="/settings" className="sidebar__nav">
          <SettingsIcon size={16} strokeWidth={2} />
          設定
        </Link>
      </div>
    </aside>
  );
}
