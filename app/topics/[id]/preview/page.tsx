import { notFound, redirect } from "next/navigation";
import { getTopic, listMessages } from "@/lib/db";
import { parseKnowledgeMap } from "@/lib/parseKnowledgeMap";
import { stripLatestQuiz } from "@/lib/parseQuiz";
import PreviewView from "./PreviewView";

export const dynamic = "force-dynamic";

export default async function PreviewPage(
  props: PageProps<"/topics/[id]/preview">,
) {
  const { id } = await props.params;
  const topic = getTopic(id);
  if (!topic) notFound();
  if (topic.status === "active") redirect(`/topics/${id}`);

  // Prefer the stored map column (so subsequent retries / restores see the
  // right data without re-parsing). Fall back to extracting from the first
  // assistant message for older drafts.
  let knowledgeMapRaw: string | null = topic.knowledge_map_markdown ?? null;
  if (!knowledgeMapRaw) {
    const messages = listMessages(id);
    const firstAssistant = messages.find((m) => m.role === "assistant");
    if (
      firstAssistant &&
      !firstAssistant.content.startsWith("__codex error__")
    ) {
      knowledgeMapRaw = stripLatestQuiz(firstAssistant.content);
    }
  }

  const parsedMap = knowledgeMapRaw
    ? parseKnowledgeMap(knowledgeMapRaw)
    : null;

  return (
    <main className="app-main">
      <h1 className="page-title">知識マップを確認</h1>
      <p className="page-subtitle">
        生成された知識マップです。そのまま使うか、編集して確定してください。
      </p>
      <PreviewView
        topic={topic}
        initialMap={parsedMap}
        fallbackRaw={knowledgeMapRaw ?? ""}
      />
    </main>
  );
}
