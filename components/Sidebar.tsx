"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { StaffIdentity } from "@/components/StaffIdentity";
import { ChuongThongBao } from "@/components/ChuongThongBao";

const LINKS = [
  { href: "/", label: "Danh sách hồ sơ Thô", icon: "📋" },
  { href: "/ho-so-hoan-thanh", label: "Danh sách hồ sơ hoàn thành", icon: "✅" },
  { href: "/cases/new", label: "Tạo hồ sơ thô mới", icon: "➕" },
  { href: "/translation-check", label: "Kiểm tra dịch thuật", icon: "🌐" },
  { href: "/tach-file", label: "Tách file PDF / Word gốc", icon: "✂️" },
  { href: "/tach-ban-dich", label: "Tách hồ sơ dịch thuật PDF / Excel", icon: "📑" },
  { href: "/mau-hop-dong", label: "Mẫu hợp đồng lao động", icon: "📄" },
  { href: "/mau-xac-nhan-kinh-nghiem", label: "Mẫu thư xác nhận kinh nghiệm", icon: "📝" },
  { href: "/mau-phieu-luong", label: "Mẫu phiếu lương", icon: "💵" },
];

export function Sidebar() {
  const pathname = usePathname();

  // Trang /admin có giao diện riêng, tách biệt hoàn toàn khỏi trang chính (xem
  // components/AdminDashboard.tsx) — không dùng chung sidebar này.
  if (pathname.startsWith("/admin")) return null;

  return (
    // `sticky` tạo lớp xếp chồng riêng: bảng thông báo của chuông (z-50) chỉ cao TRONG sidebar, còn
    // cả sidebar bị vẽ dưới nội dung trang đứng sau nó (vd khối 3D sticky ở đầu Danh sách hồ sơ) ->
    // bảng bị che. Chỉ nâng sidebar lên z-40 LÚC BẢNG ĐANG MỞ: nâng thường trực thì sidebar sẽ đè
    // lên các hộp thoại z-50 nằm trong lớp xếp chồng con của trang (ảnh giấy tờ, sửa hồ sơ...).
    <aside className="w-60 shrink-0 h-screen sticky top-0 flex flex-col bg-white border-r border-neutral-200 has-[[data-chuong-mo]]:z-40">
      <div className="flex items-center gap-1 pr-3 h-16 border-b border-neutral-200 shrink-0">
      <Link href="/" className="flex flex-1 items-center gap-2.5 pl-5 h-full min-w-0">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-600 text-white text-sm shadow-sm">
          🍁
        </span>
        <span className="font-semibold text-neutral-900 tracking-tight leading-tight text-sm">
          Checklist
          <br />
          Hồ Sơ Canada
        </span>
      </Link>
      {/* Hồ sơ đã nhận đơn vị xác nhận kinh nghiệm quá 7 ngày mà chưa làm xong — cùng danh sách
          với chuông ở trang admin. */}
      <ChuongThongBao vaiTro="docs" />
      </div>

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
      <StaffIdentity />
    </aside>
  );
}
