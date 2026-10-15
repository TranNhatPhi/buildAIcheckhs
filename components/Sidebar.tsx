"use client";

import Link from "next/link";
import { useState } from "react";
import { usePathname } from "next/navigation";
import { StaffIdentity } from "@/components/StaffIdentity";
import { ChuongThongBao } from "@/components/ChuongThongBao";
import { docJson, ghiJson } from "@/lib/luuTam";
import { useHydrated } from "@/lib/useHydrated";

// Thanh bên chia 2 NHÓM CHA mở / thu gọn được (Docs yêu cầu 15/10/2026). `them` = đường dẫn KHÔNG có link riêng
// nhưng thuộc nhóm (vd trang một hồ sơ /cases/[id]) — để nhóm đó tự mở khi đang ở trang ấy.
const NHOM = [
  {
    khoa: "tho",
    nhan: "Hồ sơ thô",
    icon: "📋",
    them: ["/cases/"],
    links: [
      { href: "/", label: "Danh sách", icon: "📋" },
      { href: "/cases/new", label: "Tạo mới", icon: "➕" },
      { href: "/tach-file", label: "Tách file PDF / Word gốc", icon: "✂️" },
      { href: "/mau-hop-dong", label: "Mẫu HĐLĐ", icon: "📄" },
      { href: "/mau-xac-nhan-kinh-nghiem", label: "Mẫu XNKN", icon: "📝" },
      { href: "/mau-phieu-luong", label: "Mẫu lương", icon: "💵" },
    ],
  },
  {
    khoa: "hoan-thanh",
    nhan: "Hồ sơ hoàn thành",
    icon: "✅",
    them: [] as string[],
    links: [
      { href: "/ho-so-hoan-thanh", label: "Danh sách", icon: "✅" },
      { href: "/tach-ban-dich", label: "Tách HS dịch", icon: "📑" },
      { href: "/translation-check", label: "Kiểm tra dịch thuật", icon: "🌐" },
      { href: "/dien-form-imm5645", label: "Điền IMM5645e", icon: "🧾" },
      { href: "/dien-form-imm1295", label: "Điền IMM1295e", icon: "🛂" },
      { href: "/mau-cv", label: "Mẫu CV", icon: "👤" },
    ],
  },
];

// "/" chỉ active đúng trang chủ, các link khác active cho cả trang con (vd /mau-cv/[id]); "/cases/new" không
// active nhầm ở /cases/[id].
const dangMo = (href: string, pathname: string) => (href === "/" ? pathname === "/" : pathname.startsWith(href));

export function Sidebar() {
  const pathname = usePathname();
  const hydrated = useHydrated();
  // Nhóm người dùng đã THU GỌN — nhớ trên trình duyệt (F5 vẫn giữ).
  const [thuGon, setThuGon] = useState<Record<string, boolean>>(() => docJson("sidebar:thuGon") ?? {});
  function doiNhom(khoa: string) {
    setThuGon((cu) => {
      const moi = { ...cu, [khoa]: !cu[khoa] };
      ghiJson("sidebar:thuGon", moi);
      return moi;
    });
  }

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

      <nav className="flex-1 overflow-y-auto px-3 py-4 flex flex-col gap-2">
        {NHOM.map((nhom) => {
          const coTrangMo =
            nhom.links.some((l) => dangMo(l.href, pathname)) || nhom.them.some((t) => pathname.startsWith(t));
          // Trước hydrate luôn MỞ (server không đọc được lựa chọn đã nhớ) — tránh lệch HTML lúc hydrate. Thu gọn
          // được cả nhóm đang chứa trang mở (tiêu đề nhóm vẫn tô tím để biết đang ở nhóm nào).
          const mo = !hydrated || !thuGon[nhom.khoa];
          return (
            <div key={nhom.khoa}>
              <button
                type="button"
                onClick={() => doiNhom(nhom.khoa)}
                aria-expanded={mo}
                className={`flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-sm font-bold transition-colors ${
                  coTrangMo ? "text-indigo-700" : "text-neutral-800 hover:bg-neutral-100"
                }`}
              >
                <span aria-hidden>{nhom.icon}</span>
                <span className="flex-1 text-left">{nhom.nhan}</span>
                <svg
                  aria-hidden
                  viewBox="0 0 20 20"
                  className={`h-4 w-4 text-neutral-400 transition-transform ${mo ? "rotate-90" : ""}`}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M7 5l5 5-5 5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              {mo && (
                <div className="ml-4 mt-1 flex flex-col gap-0.5 border-l border-neutral-200 pl-2">
                  {nhom.links.map((link) => {
                    const active = dangMo(link.href, pathname);
                    return (
                      <Link
                        key={link.href}
                        href={link.href}
                        className={`flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm font-semibold transition-colors ${
                          active
                            ? "bg-indigo-600 text-white shadow-sm"
                            : "text-neutral-600 hover:text-neutral-900 hover:bg-neutral-100"
                        }`}
                      >
                        <span aria-hidden className="text-xs">
                          {link.icon}
                        </span>
                        {link.label}
                      </Link>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </nav>
      <StaffIdentity />
    </aside>
  );
}
