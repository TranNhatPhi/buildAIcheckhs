"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Danh sách hồ sơ", icon: "📋" },
  { href: "/cases/new", label: "Tạo hồ sơ mới", icon: "➕" },
];

export function Sidebar() {
  const pathname = usePathname();

  // Trang /admin có giao diện riêng, tách biệt hoàn toàn khỏi trang chính (xem
  // components/AdminDashboard.tsx) — không dùng chung sidebar này.
  if (pathname.startsWith("/admin")) return null;

  return (
    <aside className="w-60 shrink-0 h-screen sticky top-0 flex flex-col bg-white border-r border-neutral-200">
      <Link href="/" className="flex items-center gap-2.5 px-5 h-16 border-b border-neutral-200 shrink-0">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-600 text-white text-sm shadow-sm">
          🍁
        </span>
        <span className="font-semibold text-neutral-900 tracking-tight leading-tight text-sm">
          Checklist
          <br />
          Hồ Sơ Canada
        </span>
      </Link>

      <nav className="flex-1 px-3 py-4 flex flex-col gap-1">
        {LINKS.map((link) => {
          // "/" chỉ active đúng trang chủ, các link khác active cho cả trang con (vd
          // /cases/new active khi ở /cases/new, không active nhầm ở /cases/[id]).
          const active = link.href === "/" ? pathname === "/" : pathname.startsWith(link.href);
          return (
            <Link
              key={link.href}
              href={link.href}
              className={`flex items-center gap-2.5 text-sm font-semibold px-3 py-2.5 rounded-xl transition-colors ${
                active
                  ? "bg-indigo-600 text-white shadow-sm"
                  : "text-neutral-600 hover:text-neutral-900 hover:bg-neutral-100"
              }`}
            >
              <span aria-hidden>{link.icon}</span>
              {link.label}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
