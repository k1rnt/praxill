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

  const messages = listMessages(id);
  const firstAssistant = messages.find((m) => m.role === "assistant");
  if (!firstAssistant) {
    return (
      <main className="app-main">
        <h1 className="page-title">知識マップの生成に失敗しました</h1>
        <p className="page-subtitle">
          題材を作り直すか、しばらく待ってからリトライしてください。
        </p>
      </main>
    );
  }

  const knowledgeMapRaw = stripLatestQuiz(firstAssistant.content);
  const parsedMap = parseKnowledgeMap(knowledgeMapRaw);

  return (
    <main className="app-main">
      <h1 className="page-title">知識マップを確認</h1>
      <p className="page-subtitle">
        Trainer が生成したマップです。そのまま使うか、編集して「学習を始める」を押してください。
      </p>
      <PreviewView
        topic={topic}
        initialMap={parsedMap}
        fallbackRaw={knowledgeMapRaw}
      />
    </main>
  );
}
