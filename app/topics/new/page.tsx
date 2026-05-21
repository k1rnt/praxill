import NewTopicForm from "./NewTopicForm";

export default function NewTopicPage() {
  return (
    <main className="app-main">
      <h1 className="page-title">新しい題材</h1>
      <p className="page-subtitle">
        題材と目的を入力すると、知識マップと Phase 1 のクイズを生成します。
      </p>
      <NewTopicForm />
    </main>
  );
}
