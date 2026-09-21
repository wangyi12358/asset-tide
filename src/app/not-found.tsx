import Link from "next/link";
export default function NotFound() {
  return (
    <main className="empty min-h-screen">
      <p className="eyebrow">404 · OFF THE MAP</p>
      <h1>这一页暂时不在地图上</h1>
      <Link href="/dashboard" className="action mt-5">
        返回资产总览
      </Link>
    </main>
  );
}
