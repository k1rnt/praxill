"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

type Props = {
  href: string;
  topicId: string;
  title: string;
  draft: boolean;
};

/**
 * Sidebar entry for a single topic. Picks "active" by matching the topic id
 * inside the current pathname — both /topics/[id] and /topics/[id]/preview
 * count as active for the same row.
 */
export function SidebarTopicLink({ href, topicId, title, draft }: Props) {
  const pathname = usePathname() ?? "";
  const active = pathname.startsWith(`/topics/${topicId}`);
  return (
    <Link
      href={href}
      className={`sidebar__topic${active ? " sidebar__topic--active" : ""}`}
      aria-current={active ? "page" : undefined}
    >
      <span className="sidebar__topic-title">{title}</span>
      {draft && <span className="sidebar__topic-tag">下書き</span>}
    </Link>
  );
}
