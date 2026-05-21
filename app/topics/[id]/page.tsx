import { notFound } from "next/navigation";
import Link from "next/link";
import { getTopic, listMessages } from "@/lib/db";
import ChatView from "./ChatView";

export const dynamic = "force-dynamic";

export default async function TopicPage(props: PageProps<"/topics/[id]">) {
  const { id } = await props.params;
  const topic = getTopic(id);
  if (!topic) notFound();
  const messages = listMessages(id);

  return (
    <main className="app-main app-main--chat">
      <div style={{ marginBottom: 8 }}>
        <Link className="btn btn--ghost" href="/">
          ← 一覧
        </Link>
      </div>
      <ChatView topic={topic} initialMessages={messages} />
    </main>
  );
}
