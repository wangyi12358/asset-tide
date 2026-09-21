"use client";
export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <div className="empty">
      <h2>页面暂时无法加载</h2>
      <p>你的记录仍保存在数据库中，请稍后重试。</p>
      <button className="action" onClick={reset}>
        重新加载
      </button>
    </div>
  );
}
